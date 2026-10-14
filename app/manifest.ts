import type { MetadataRoute } from "next";

/**
 * Lets the owner "Add to Home Screen" and get an app that opens straight into
 * the dashboard, full-screen, with no browser bar — which is how they will
 * actually use it, next to WhatsApp on the same phone.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "WhatsApp AI Agent",
    short_name: "AI Agent",
    description: "See what your WhatsApp sales assistant is doing.",
    start_url: "/dashboard",
    display: "standalone",
    background_color: "#f3f5f2",
    theme_color: "#0b5d3f",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml" }],
  };
}
