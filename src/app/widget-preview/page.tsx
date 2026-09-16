'use client';

// ============================================================
// /widget-preview?token=<widget_token>
//
// What "Test chat" in Settings → Channels → Web Widget opens (in a
// small popup window — see web-widget-channel.tsx). Deliberately NOT
// a reimplementation of the chat UI: it loads the exact same
// public/widget/loader.js bundle a real visitor's browser would, with
// `data-open="true"` so it drops straight into an open conversation
// instead of requiring a click on a launcher bubble on an otherwise
// blank page. Testing this page IS testing the real widget — there is
// no second chat implementation to drift out of sync with it.
//
// Public route, same as the widget itself — the widget_token in the
// query string carries no more exposure than the same token already
// sitting in the embed snippet on the account's own website.
// ============================================================

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import Script from 'next/script';
import { MessageCircle } from 'lucide-react';

export default function WidgetPreviewPage() {
  return (
    <Suspense fallback={null}>
      <WidgetPreviewInner />
    </Suspense>
  );
}

function WidgetPreviewInner() {
  const token = useSearchParams().get('token');

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-background p-6 text-center">
      {token ? (
        <>
          <MessageCircle className="size-8 text-muted-foreground" />
          <div>
            <p className="text-sm font-medium text-foreground">
              Testing your Web Widget
            </p>
            <p className="mt-1 max-w-xs text-xs text-muted-foreground">
              This is the exact widget your visitors see. Messages you
              send here land in your real Inbox.
            </p>
          </div>
          <Script src="/widget/loader.js" data-widget-token={token} data-open="true" strategy="afterInteractive" />
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          Missing widget token — open this page from Settings → Channels → Web Widget.
        </p>
      )}
    </div>
  );
}
