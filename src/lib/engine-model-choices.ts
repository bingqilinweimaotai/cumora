/**
 * Option list for the per-computer engine model pickers on the Me page.
 *
 * The catalog comes from the daemon on that computer (the only process that
 * knows which models its CLI login can actually reach), so the picker shows
 * real choices instead of asking the operator to type a vendor model id from
 * memory. A daemon that cannot enumerate (older build, custom endpoint) still
 * reports `supportsCustom`, and the picker keeps free-form entry for it.
 *
 * Pure and React-free so the row rules can be pinned without rendering.
 */

/** Structural twin of the <Combobox> option, minus the component import. */
export interface ModelChoiceOption {
  value: string
  label: string
  hint?: string
}

export interface ModelChoiceCatalog {
  models: ReadonlyArray<{
    id: string
    label: string
    recommendedFor?: ReadonlyArray<'big' | 'small'>
  }>
  defaultModel: string | null
  defaultFastModel: string | null
}

/**
 * First row is the empty value — "no Cumora-side default" — hinted with the
 * model the engine would fall back to, so the operator can see what blank
 * actually means before choosing it.
 */
export function engineModelChoices(
  catalog: ModelChoiceCatalog | undefined,
  tier: 'big' | 'small',
  labels: { follow: string; recommended: string },
): ModelChoiceOption[] {
  const fallback = tier === 'big' ? catalog?.defaultModel : catalog?.defaultFastModel
  return [
    { value: '', label: labels.follow, hint: fallback ?? undefined },
    ...(catalog?.models ?? []).map((model) => ({
      value: model.id,
      label: model.label,
      hint: [
        model.label !== model.id ? model.id : null,
        model.recommendedFor?.includes(tier) ? labels.recommended : null,
      ].filter(Boolean).join(' · ') || undefined,
    })),
  ]
}
