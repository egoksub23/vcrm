'use client';

import { useTranslations } from 'next-intl';

import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { normalizeHexColor, TAG_COLOR_PRESETS } from '@/lib/tags/tag-csv';

/**
 * Colour chooser for a tag: the preset swatches, a native colour input
 * for anything else, and a hex field. `value` is always a `#rrggbb`
 * string; a half-typed hex is held locally-invisible until it parses.
 */
export function TagColorPicker({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (hex: string) => void;
  disabled?: boolean;
}) {
  const t = useTranslations('Settings.tagsAndFields');
  const tc = useTranslations('Settings.tagCatalog');
  const isPreset = TAG_COLOR_PRESETS.some((p) => p.value === value);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {TAG_COLOR_PRESETS.map((color) => {
          const label = t(`colors.${color.name}` as Parameters<typeof t>[0]);
          return (
            <button
              key={color.value}
              type="button"
              disabled={disabled}
              onClick={() => onChange(color.value)}
              aria-label={t('useColor', { color: label })}
              aria-pressed={value === color.value}
              title={label}
              className={cn(
                'size-6 rounded-md transition-transform hover:scale-110 disabled:opacity-50',
                value === color.value && 'outline outline-2 outline-offset-2 outline-primary',
              )}
              style={{ backgroundColor: color.value }}
            />
          );
        })}
        <label
          title={tc('customColor')}
          className={cn(
            'relative size-6 cursor-pointer overflow-hidden rounded-md border border-dashed border-border',
            !isPreset && 'outline outline-2 outline-offset-2 outline-primary',
            disabled && 'pointer-events-none opacity-50',
          )}
          style={!isPreset ? { backgroundColor: value } : undefined}
        >
          <input
            type="color"
            value={value}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value.toLowerCase())}
            aria-label={tc('customColor')}
            className="absolute inset-0 size-full cursor-pointer opacity-0"
          />
          {isPreset ? (
            <span className="flex size-full items-center justify-center text-xs text-muted-foreground">
              +
            </span>
          ) : null}
        </label>
      </div>
      {/* Keyed on the value so picking a swatch resets the typed draft. */}
      <HexInput key={value} value={value} onChange={onChange} disabled={disabled} label={tc('hexLabel')} />
    </div>
  );
}

function HexInput({
  value,
  onChange,
  disabled,
  label,
}: {
  value: string;
  onChange: (hex: string) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <Input
      defaultValue={value}
      disabled={disabled}
      aria-label={label}
      maxLength={7}
      spellCheck={false}
      onChange={(e) => {
        const hex = normalizeHexColor(e.target.value);
        if (hex && hex !== value) onChange(hex);
      }}
      className="h-8 w-28 font-mono text-xs"
    />
  );
}
