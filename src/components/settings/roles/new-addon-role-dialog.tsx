'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ADDON_DESCRIPTION_MAX, ADDON_NAME_MAX } from '@/lib/auth/addon-roles';

/** Make a new add-on role: a name (and a description). The permissions are chosen in the editor straight after, with the role selected. */
export function NewAddonRoleDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (id: string) => void;
}) {
  const t = useTranslations('Permissions.addons');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    // start empty each time the dialog opens
    setName('');
    setDescription('');
    setError(null);
  }, [open]);

  async function create() {
    const trimmed = name.trim();
    if (!trimmed) {
      setError(t('nameRequired'));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/account/roles/addons', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed, description: description.trim() || undefined, capabilities: [] }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; id?: string };
      if (!res.ok || !data.id) {
        setError(data.error || t('createFailed'));
        return;
      }
      toast.success(t('created', { name: trimmed }));
      onOpenChange(false);
      onCreated(data.id);
    } catch {
      setError(t('createFailed'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !saving && onOpenChange(next)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('newRoleTitle')}</DialogTitle>
          <DialogDescription>{t('newRoleDescription')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="new-addon-name">{t('nameLabel')}</Label>
            <Input
              id="new-addon-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('namePlaceholder')}
              maxLength={ADDON_NAME_MAX}
              autoFocus
              disabled={saving}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !saving && name.trim()) {
                  e.preventDefault();
                  void create();
                }
              }}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="new-addon-desc">{t('descriptionLabel')}</Label>
            <Textarea
              id="new-addon-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('descriptionPlaceholder')}
              maxLength={ADDON_DESCRIPTION_MAX}
              rows={2}
              disabled={saving}
            />
          </div>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            {t('cancel')}
          </Button>
          <Button onClick={() => void create()} disabled={saving || !name.trim()}>
            {saving ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : null}
            {t('create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
