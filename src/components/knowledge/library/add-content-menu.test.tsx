import { describe, it, expect } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { DropdownMenu, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel } from '@/components/ui/dropdown-menu'

/**
 * Regression: AddContentMenu's dropdown content shipped with two
 * DropdownMenuLabel groups ("Write directly" / "Bring content in") not
 * wrapped in a DropdownMenuGroup. DropdownMenuLabel is base-ui's
 * Menu.GroupLabel, which throws at render without a Menu.Group ancestor
 * (see dropdown-menu-group-label.test.tsx, issue #336) — so opening the
 * "+ Add content" menu crashed the whole Knowledge base page in
 * production. This pins the exact two-group shape the menu renders.
 */
describe('AddContentMenu dropdown content', () => {
  it('renders the "write" and "import" label groups without throwing', () => {
    expect(() =>
      renderToStaticMarkup(
        React.createElement(
          DropdownMenu,
          null,
          React.createElement(
            DropdownMenuGroup,
            null,
            React.createElement(DropdownMenuLabel, null, 'Write directly'),
            React.createElement(DropdownMenuItem, null, 'Article'),
            React.createElement(DropdownMenuItem, null, 'Q&A'),
          ),
          React.createElement(
            DropdownMenuGroup,
            null,
            React.createElement(DropdownMenuLabel, null, 'Bring content in'),
            React.createElement(DropdownMenuItem, null, 'Bulk import Q&A (CSV)'),
          ),
        ),
      ),
    ).not.toThrow()
  })
})
