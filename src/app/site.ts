/** Site-level constants: the same for every data app, so they live here and not in a config. */

export const SITE = 'Manyfold Data';

/** The Manyfold community on Discord: the top bar's link outside a data app, and the fallback inside one. */
export const DISCORD_URL = 'https://discord.gg/vaRbSGmUG';

/** Where a data app's Discord button goes: its own channel's invite, or the community's when it has none. */
export const discordHref = (invite: string | null | undefined): string => invite || DISCORD_URL;
