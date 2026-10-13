'use client';

import { createContext, useContext } from 'react';

/**
 * The name of the card a page is shown in, when the new shell opens a page of
 * More as a card above the app (`Shell · chats · Settings card`). The card's
 * head already carries it: a page header that would only repeat it drops its
 * title and keeps its subtitle and actions. Outside a card it is null and
 * nothing changes.
 */
export const CardTitleContext = createContext<string | null>(null);

export function useCardTitle(): string | null {
  return useContext(CardTitleContext);
}
