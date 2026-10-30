FROM node:24-alpine AS dependencies
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.9.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM dependencies AS build
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

FROM dependencies AS node-pack
RUN apk add --no-cache upx \
    && upx -5 /usr/local/bin/node

FROM alpine:3.24 AS ffmpeg-build
RUN apk add --no-cache build-base curl nasm xz
WORKDIR /build
RUN curl -fsSL --retry 3 https://ffmpeg.org/releases/ffmpeg-8.1.3.tar.xz -o ffmpeg.tar.xz \
    && echo 'acc7dbacde58c91bbc4a86fa589d317515d40bc9bc1ca5f9c020034bb54bf3c8cd61ed70ce437b962bd50332ea8378b3ad52da1942cfdb29e380c33a90d2f0c1  ffmpeg.tar.xz' | sha512sum -c - \
    && tar -xf ffmpeg.tar.xz --strip-components=1
RUN ./configure --disable-everything --disable-doc --disable-debug --disable-autodetect \
    --disable-ffplay --disable-ffprobe \
    --enable-protocol=file,pipe,tcp,udp,rtp \
    --enable-demuxer=mpegps,rtsp,sdp \
    --enable-muxer=mp4,mov,tee \
    --enable-parser=h264,hevc,mpegvideo,aac \
    --enable-decoder=h264,hevc,pcm_alaw,pcm_mulaw,aac \
    --enable-bsf=aac_adtstoasc,extract_extradata,h264_mp4toannexb,hevc_mp4toannexb \
    && make -j"$(nproc)" ffmpeg \
    && strip ffmpeg

FROM alpine:3.24 AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
RUN apk add --no-cache libstdc++ \
    && addgroup -g 1000 node \
    && adduser -D -u 1000 -G node node
COPY --from=node-pack /usr/local/bin/node /usr/local/bin/node
COPY --from=ffmpeg-build /build/ffmpeg /usr/local/bin/ffmpeg
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
USER node
EXPOSE 3000
CMD ["node", "server.js"]
