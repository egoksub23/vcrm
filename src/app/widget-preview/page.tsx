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

import { Suspense, useState } from 'react';
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

// "Simulate an in-app user" (Web Widget v2). A real host app's backend signs
// an identity token for its signed-in user; here an admin asks the dashboard
// to sign one for a made-up user (admin-only route, signed with the
// workspace's real secret) and hands it to the widget exactly as a host app
// would: window.VircleWidget.identify({ token }).
type VircleWidgetApi = { identify?: (input: { token?: string }) => void };

function SimulateInAppUser() {
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function simulate() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch('/api/account/channels/web-widget/identity-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, email, name }),
      });
      const data = (await res.json().catch(() => ({}))) as { token?: string; error?: string };
      if (!res.ok || !data.token) {
        setMessage({
          ok: false,
          text:
            res.status === 401 || res.status === 403
              ? 'Sign in to the dashboard as an admin in this browser to simulate an in-app user.'
              : data.error || 'Could not create a test identity.',
        });
        return;
      }
      const widget = (window as unknown as { VircleWidget?: VircleWidgetApi }).VircleWidget;
      if (!widget?.identify) {
        setMessage({ ok: false, text: 'The widget has not finished loading yet. Try again in a moment.' });
        return;
      }
      widget.identify({ token: data.token });
      setMessage({
        ok: true,
        text: 'Identity handed to the widget. Open the chat: this visitor now counts as verified in the Inbox.',
      });
    } catch {
      setMessage({ ok: false, text: 'Could not create a test identity.' });
    } finally {
      setBusy(false);
    }
  }

  const fieldClass =
    'w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-xs text-foreground placeholder:text-muted-foreground';

  return (
    <details className="mt-2 w-full max-w-xs rounded-lg border border-border bg-card p-3 text-left">
      <summary className="cursor-pointer text-xs font-medium text-foreground">Simulate an in-app user</summary>
      <p className="mt-2 text-xs text-muted-foreground">
        Pretends this page belongs to a signed-in user of your app. Needs the in-app identity secret
        (Settings, Channels, Web Widget). Use a private window for a brand-new visitor.
      </p>
      <div className="mt-2 space-y-1.5">
        <input className={fieldClass} placeholder="Phone, e.g. +60123980112" value={phone} onChange={(e) => setPhone(e.target.value)} />
        <input className={fieldClass} placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <input className={fieldClass} placeholder="Name (optional)" value={name} onChange={(e) => setName(e.target.value)} />
        <button
          type="button"
          onClick={() => void simulate()}
          disabled={busy || (!phone.trim() && !email.trim())}
          className="w-full rounded-md bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
        >
          {busy ? 'Signing...' : 'Sign in as this user'}
        </button>
      </div>
      {message ? (
        <p className={message.ok ? 'mt-2 text-xs text-emerald-600' : 'mt-2 text-xs text-red-500'}>{message.text}</p>
      ) : null}
    </details>
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
          <SimulateInAppUser />
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
