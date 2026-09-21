'use client';

import { useState, useEffect } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { useCapability } from '@/hooks/use-can';
import { addContactTag, deleteContactTag } from '@/lib/contacts/tag-api';
import { toast } from 'sonner';
import type { Contact, Tag, ContactTag, LifecycleStage } from '@/types';
import {
  findExistingContact,
  isExactMatch,
  isUniqueViolation,
  type ExistingContact,
} from '@/lib/contacts/dedupe';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Loader2, AlertTriangle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { mergeContacts } from '@/lib/contacts/merge-api';

interface ContactFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contact?: Contact | null;
  contactTags?: ContactTag[];
  onSaved: () => void;
  /** Open an existing contact's detail view — used by the duplicate
   *  notice to jump to the contact that already owns this number. */
  onViewExisting?: (contactId: string) => void;
}

export function ContactForm({
  open,
  onOpenChange,
  contact,
  contactTags = [],
  onSaved,
  onViewExisting,
}: ContactFormProps) {
  const t = useTranslations('Contacts.form');
  const supabase = createClient();
  const { accountId } = useAuth();
  // Reached only from gated entry points; the submit button repeats the check (contacts.edit).
  const canEdit = useCapability('contacts.edit');
  // Merging two contacts is its own capability (POST /api/contacts/merge).
  const canMerge = useCapability('contacts.merge');
  const isEdit = !!contact;

  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [company, setCompany] = useState('');
  const [lifecycleStage, setLifecycleStage] = useState<LifecycleStage>('lead');
  const [saving, setSaving] = useState(false);

  // Duplicate-phone detection for NEW contacts. `exact` (same digits)
  // hard-blocks the save; a fuzzy trunk-variant match only warns. The
  // DB unique index (migration 022) is the real backstop — this is the
  // friendly heads-up before we get there.
  const [dupMatch, setDupMatch] = useState<
    { contact: ExistingContact; exact: boolean } | null
  >(null);
  const [checkingDup, setCheckingDup] = useState(false);
  // Edit only: the merge confirmation step inside the duplicate notice.
  const [confirmingMerge, setConfirmingMerge] = useState(false);
  const [merging, setMerging] = useState(false);

  const [tags, setTags] = useState<Tag[]>([]);
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [loadingTags, setLoadingTags] = useState(false);

  useEffect(() => {
    if (open) {
      setName(contact?.name ?? '');
      setPhone(contact?.phone ?? '');
      setEmail(contact?.email ?? '');
      setCompany(contact?.company ?? '');
      setLifecycleStage(contact?.lifecycle_stage ?? 'lead');
      setSelectedTagIds(contactTags.map((ct) => ct.tag_id));
      setDupMatch(null);
      setConfirmingMerge(false);
      fetchTags();
    }
  }, [open, contact]);

  // Look up an existing contact with this number. For an edit, the contact
  // being edited is excluded and an unchanged phone is not checked.
  // Runs on blur so we don't query on every keystroke.
  async function checkDuplicate() {
    if (!accountId) return;
    const value = phone.trim();
    if (!value || (isEdit && value === contact?.phone)) {
      setDupMatch(null);
      return;
    }
    setCheckingDup(true);
    try {
      const existing = await findExistingContact(supabase, accountId, value, contact?.id);
      setDupMatch(
        existing
          ? { contact: existing, exact: isExactMatch(existing, value) }
          : null,
      );
    } finally {
      setCheckingDup(false);
    }
  }

  async function fetchTags() {
    setLoadingTags(true);
    // Contact tags only — conversation-only labels (migration 068) aren't offered here.
    const { data } = await supabase
      .from('tags')
      .select('*')
      .eq('for_contacts', true)
      // A tag that still waits for approval (migration 084) is not offered.
      .eq('approval_status', 'approved')
      .order('name');
    if (data) setTags(data);
    setLoadingTags(false);
  }

  function toggleTag(tagId: string) {
    setSelectedTagIds((prev) =>
      prev.includes(tagId)
        ? prev.filter((id) => id !== tagId)
        : [...prev, tagId]
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canEdit) return;

    if (!phone.trim()) {
      toast.error(t('phoneRequired'));
      return;
    }

    // Hard-block an exact duplicate, on create and on a phone edit (the DB
    // unique index is the real backstop; this avoids a round-trip + a raw
    // error toast).
    if (dupMatch?.exact) {
      toast.error(t('toastConflictNamed', { name: dupMatch.contact.name || dupMatch.contact.phone }));
      return;
    }

    setSaving(true);

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const user = session?.user;
      if (!user) throw new Error('Not authenticated');
      if (!accountId) throw new Error('Your profile is not linked to an account.');

      let contactId = contact?.id;

      if (isEdit && contactId) {
        const stageChanged = lifecycleStage !== (contact?.lifecycle_stage ?? 'lead');
        const { error } = await supabase
          .from('contacts')
          .update({
            name: name.trim() || null,
            phone: phone.trim(),
            email: email.trim() || null,
            company: company.trim() || null,
            lifecycle_stage: lifecycleStage,
            ...(stageChanged ? { lifecycle_stage_changed_at: new Date().toISOString() } : {}),
            updated_at: new Date().toISOString(),
          })
          .eq('id', contactId);
        if (error) throw error;
      } else {
        const { data, error } = await supabase
          .from('contacts')
          .insert({
            user_id: user.id,
            account_id: accountId,
            name: name.trim() || null,
            phone: phone.trim(),
            email: email.trim() || null,
            company: company.trim() || null,
            lifecycle_stage: lifecycleStage,
            lifecycle_stage_changed_at: lifecycleStage === 'lead' ? null : new Date().toISOString(),
          })
          .select('id')
          .single();
        if (error) throw error;
        contactId = data.id;
      }

      // Sync tags
      if (contactId) {
        const existingTagIds = new Set(contactTags.map((tag) => tag.tag_id));
        const desiredTagIds = new Set(selectedTagIds);
        const toRemove = [...existingTagIds].filter((id) => !desiredTagIds.has(id));
        const toAdd = [...desiredTagIds].filter((id) => !existingTagIds.has(id));

        for (const tagId of toRemove) {
          await deleteContactTag(contactId, tagId);
        }
        for (const tagId of toAdd) {
          await addContactTag(contactId, tagId);
        }
      }

      toast.success(isEdit ? t('toastSuccessEdit') : t('toastSuccessAdd'));
      onOpenChange(false);
      onSaved();
    } catch (err: unknown) {
      // The unique index (migration 022) rejects a duplicate phone that
      // slipped past the on-blur check (race, or a format that
      // normalizes equal). Surface it as the friendly duplicate notice
      // and, for new contacts, point the user at the existing record.
      if (isUniqueViolation(err)) {
        const existing = accountId
          ? await findExistingContact(supabase, accountId, phone.trim(), contact?.id)
          : null;
        if (existing) {
          setDupMatch({ contact: existing, exact: true });
          toast.error(t('toastConflictNamed', { name: existing.name || existing.phone }));
        } else {
          toast.error(t('toastConflict'));
        }
        return;
      }
      const message = err instanceof Error ? err.message : t('toastError');
      toast.error(message);
    } finally {
      setSaving(false);
    }
  }

  // Edit only: fold the contact that owns the typed number into this one.
  // The number itself is saved afterwards with the normal Update button.
  async function handleMerge() {
    if (!canMerge || !contact || !dupMatch) return;
    setMerging(true);
    try {
      await mergeContacts(contact.id, dupMatch.contact.id);
      toast.success(t('toastMerged'));
      setDupMatch(null);
      setConfirmingMerge(false);
      onSaved();
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'unknown error';
      toast.error(t('toastMergeFailed', { reason }));
    } finally {
      setMerging(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-popover border-border text-popover-foreground sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">
            {isEdit ? t('editTitle') : t('addTitle')}
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {isEdit
              ? t('editDesc')
              : t('addDesc')}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="cf-name" className="text-muted-foreground">
              {t('nameLabel')}
            </Label>
            <Input
              id="cf-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('namePlaceholder')}
              className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="cf-phone" className="text-muted-foreground">
              {t('phoneLabel')} <span className="text-red-400">*</span>
            </Label>
            <Input
              id="cf-phone"
              value={phone}
              onChange={(e) => {
                setPhone(e.target.value);
                if (dupMatch) setDupMatch(null);
              }}
              onBlur={checkDuplicate}
              placeholder={t('phonePlaceholder')}
              className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
            />
            {dupMatch ? (
              <div
                className={`flex items-start gap-2 rounded-md border px-2.5 py-2 text-xs ${
                  dupMatch.exact
                    ? 'border-red-500/40 bg-red-500/10 text-red-300'
                    : 'border-amber-500/40 bg-amber-500/10 text-amber-300'
                }`}
              >
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                <div className="space-y-1">
                  <p>
                    {dupMatch.exact
                      ? t('dupExactNamed', {
                          name: dupMatch.contact.name || dupMatch.contact.phone,
                        })
                      : t('dupSimilar')}
                  </p>
                  {isEdit && dupMatch.exact && (
                    canMerge ? (
                      confirmingMerge ? (
                        <div className="space-y-2">
                          <p>
                            {t('mergeConfirmText', {
                              name: dupMatch.contact.name || dupMatch.contact.phone,
                            })}
                          </p>
                          <div className="flex gap-2">
                            <Button
                              type="button"
                              size="sm"
                              variant="destructive"
                              onClick={handleMerge}
                              disabled={merging}
                            >
                              {merging && <Loader2 className="size-3.5 animate-spin" />}
                              {merging ? t('merging') : t('mergeConfirmBtn')}
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              onClick={() => setConfirmingMerge(false)}
                              disabled={merging}
                              className="border-border text-muted-foreground hover:bg-muted"
                            >
                              {t('mergeKeepBtn')}
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => setConfirmingMerge(true)}
                          className="border-border text-foreground hover:bg-muted"
                        >
                          {t('mergeContactsBtn')}
                        </Button>
                      )
                    ) : (
                      <p>{t('mergeAskColleague')}</p>
                    )
                  )}
                  {onViewExisting && (
                    <button
                      type="button"
                      onClick={() => onViewExisting(dupMatch.contact.id)}
                      className="font-medium underline underline-offset-2 hover:no-underline"
                    >
                      {t('viewExisting', { name: dupMatch.contact.name || dupMatch.contact.phone })}
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                {t('phoneHint')}
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="cf-email" className="text-muted-foreground">
              {t('emailLabel')}
            </Label>
            <Input
              id="cf-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={t('emailPlaceholder')}
              className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="cf-company" className="text-muted-foreground">
              {t('companyLabel')}
            </Label>
            <Input
              id="cf-company"
              value={company}
              onChange={(e) => setCompany(e.target.value)}
              placeholder={t('companyPlaceholder')}
              className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="cf-lifecycle" className="text-muted-foreground">
              {t('lifecycleStageLabel')}
            </Label>
            <select
              id="cf-lifecycle"
              value={lifecycleStage}
              onChange={(e) => setLifecycleStage(e.target.value as LifecycleStage)}
              className="w-full rounded-md border border-border bg-muted px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none"
            >
              <option value="lead">{t('lifecycleStage.lead')}</option>
              <option value="active">{t('lifecycleStage.active')}</option>
              <option value="customer">{t('lifecycleStage.customer')}</option>
              <option value="churned">{t('lifecycleStage.churned')}</option>
            </select>
          </div>

          <div className="space-y-2">
            <Label className="text-muted-foreground">{t('tagsLabel')}</Label>
            {loadingTags ? (
              <div className="flex items-center gap-2 text-muted-foreground text-sm">
                <Loader2 className="size-3 animate-spin" />
                {t('loadingTags')}
              </div>
            ) : tags.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {t('noTagsAvailable')}
              </p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {tags.map((tag) => {
                  const selected = selectedTagIds.includes(tag.id);
                  return (
                    <button
                      key={tag.id}
                      type="button"
                      onClick={() => toggleTag(tag.id)}
                      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors cursor-pointer ${
                        selected
                          ? 'ring-2 ring-primary ring-offset-1 ring-offset-border'
                          : 'opacity-60 hover:opacity-100'
                      }`}
                      style={{
                        backgroundColor: tag.color + '20',
                        color: tag.color,
                        borderColor: tag.color,
                      }}
                    >
                      {tag.name}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <DialogFooter className="bg-popover border-border">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              {t('cancel')}
            </Button>
            <Button
              type="submit"
              disabled={!canEdit || saving || checkingDup || merging || !!dupMatch?.exact}
              className="bg-primary hover:bg-primary/90 text-primary-foreground"
            >
              {saving && <Loader2 className="size-4 animate-spin" />}
              {isEdit ? t('update') : t('create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
