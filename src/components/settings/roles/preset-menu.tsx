'use client';

import { Sparkles } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { PRESETS, type CapabilityPreset } from '@/lib/auth/capabilities';
import type { AccountRole } from '@/lib/auth/roles';

interface PresetMenuProps {
  role: AccountRole;
  disabled: boolean;
  onApply: (preset: CapabilityPreset) => void;
}

/** "Apply preset": picking one fills the DRAFT; nothing is saved yet. */
export function PresetMenu({ role, disabled, onApply }: PresetMenuProps) {
  const t = useTranslations('Permissions');
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="outline" size="sm" disabled={disabled} />}
      >
        <Sparkles className="size-3.5" />
        {t('screen.applyPreset')}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72 max-w-[calc(100vw-2rem)]">
        {PRESETS.map((preset) => (
          <DropdownMenuItem
            key={preset.id}
            onClick={() => onApply(preset)}
            className="flex-col items-start gap-0.5 py-2"
          >
            <span className="flex w-full items-center gap-2 text-sm font-medium">
              {t(`preset.${preset.id}.name`)}
              {preset.role === role ? (
                <span className="rounded-full bg-primary-soft px-1.5 text-[10px] font-medium text-primary">
                  {t('screen.presetSuggested')}
                </span>
              ) : null}
            </span>
            <span className="text-xs whitespace-normal text-muted-foreground">
              {t(`preset.${preset.id}.description`)}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
