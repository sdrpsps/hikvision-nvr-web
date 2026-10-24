import { QueryClient } from "@tanstack/react-query"

export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        // A missing internet connection must not pause same-origin LAN reads.
        networkMode: "always",
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
      },
      mutations: {
        retry: false,
        networkMode: "always",
        gcTime: 0,
      },
    },
  })
}

let browserQueryClient: QueryClient | undefined

export function getQueryClient() {
  // Server renders never share a cache; navigation reuses the browser's client.
  if (typeof window === "undefined") return createQueryClient()
  return (browserQueryClient ??= createQueryClient())
}
