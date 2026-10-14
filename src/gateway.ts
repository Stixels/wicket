/** "claude-sonnet-5-5" -> "anthropic/claude-sonnet-5.5", the Vercel AI Gateway's naming. Full gateway ids pass through. */
export function gatewayModelId(id: string): string {
  return id.includes("/") ? id : `anthropic/${id.replace(/-(\d+)-(\d+)$/, "-$1.$2")}`;
}
