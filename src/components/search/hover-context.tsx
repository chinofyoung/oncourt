'use client'

import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'

/**
 * The one genuinely client-side piece of state on `/search`: which card/pin
 * the pointer is on. Everything else — filters, results, ordering — is
 * server-rendered from the URL by `src/app/search/page.tsx`.
 *
 * It lives in context rather than in a component's `useState` because the
 * mockup's layout puts the map in a full-bleed hero at the top of the page
 * and the cards in `<main>` below it. Those are separate regions, so no
 * single client component can own the state without swallowing the whole
 * page and forcing it all client-side. The provider wraps both regions while
 * their contents stay Server Components.
 */
type CardHover = {
  activeId: string | null
  setActiveId: (id: string | null) => void
}

const CardHoverContext = createContext<CardHover>({
  activeId: null,
  setActiveId: () => {},
})

export function CardHoverProvider({ children }: { children: ReactNode }) {
  const [activeId, setActiveId] = useState<string | null>(null)
  // `setActiveId` is referentially stable (React guarantees it for `useState`
  // setters), so this memo only changes when `activeId` actually changes.
  const value = useMemo(() => ({ activeId, setActiveId }), [activeId])
  return <CardHoverContext.Provider value={value}>{children}</CardHoverContext.Provider>
}

export function useCardHover() {
  return useContext(CardHoverContext)
}
