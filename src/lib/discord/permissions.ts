export const ADMINISTRATOR = 1n << 3n;
export const MANAGE_GUILD = 1n << 5n;
export const BOT_PERMISSIONS = (1n << 10n) | (1n << 11n) | (1n << 14n) | (1n << 16n);

export function canSetup(permissions: string) {
  const value = BigInt(permissions);
  return (value & (ADMINISTRATOR | MANAGE_GUILD)) !== 0n;
}

type Overwrite = { id: string; type: number; allow: string; deny: string };
export function channelPermissions(guildId: string, botId: string, memberRoles: string[], roles: { id: string; permissions: string }[], overwrites: Overwrite[]) {
  const relevant = new Set([guildId, ...memberRoles]);
  let permissions = roles.filter((role) => relevant.has(role.id)).reduce((value, role) => value | BigInt(role.permissions), 0n);
  if ((permissions & ADMINISTRATOR) !== 0n) return BOT_PERMISSIONS;
  const apply = (rows: Overwrite[]) => {
    const allow = rows.reduce((value, row) => value | BigInt(row.allow), 0n);
    const deny = rows.reduce((value, row) => value | BigInt(row.deny), 0n);
    permissions = (permissions & ~deny) | allow;
  };
  apply(overwrites.filter((row) => row.id === guildId && row.type === 0));
  apply(overwrites.filter((row) => row.type === 0 && row.id !== guildId && relevant.has(row.id)));
  apply(overwrites.filter((row) => row.type === 1 && row.id === botId));
  return permissions;
}
