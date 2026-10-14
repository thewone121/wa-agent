"use client";

/**
 * Lets an open thread tell the chat list to reload.
 *
 * The list lives in the inbox layout and the thread in a child page, so when
 * the owner resumes or closes a chat the list would otherwise show the old
 * status until its next poll. Its own module because a Next.js layout file may
 * only export the component itself.
 */

import { createContext, useContext } from "react";

export const InboxContext = createContext<{ refresh: () => void }>({ refresh: () => {} });

export function useInbox() {
  return useContext(InboxContext);
}
