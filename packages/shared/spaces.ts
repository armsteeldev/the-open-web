/** Public metadata shared by the frontend and backend for visitor-facing spaces. */
export interface SpaceDefinition {
  /** Stable identifier used by the API and realtime subscription protocol. */
  readonly id: string;
  /** Short name shown in the global navigation. */
  readonly label: string;
  /** Canonical frontend path, without a trailing slash. */
  readonly path: string;
  /** Inactive entries are not linked and may not register server functionality. */
  readonly status: 'active' | 'inactive';
}

/** Only finished, visitor-facing spaces belong here. */
export const spaces = [
  { id: 'wall', label: 'The Wall', path: '/wall', status: 'active' },
  { id: 'chat', label: 'Global Chat', path: '/chat', status: 'active' },
  { id: 'bottle', label: 'Message in a Bottle', path: '/bottle', status: 'active' },
] as const satisfies readonly SpaceDefinition[];

/** Validate registry data at application startup and in repository checks. */
export function validateSpaceRegistry(registry: readonly SpaceDefinition[] = spaces): void {
  const ids = new Set<string>();
  const paths = new Set<string>();

  for (const space of registry) {
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(space.id)) {
      throw new Error(`Invalid space id: ${space.id}`);
    }
    if (ids.has(space.id)) throw new Error(`Duplicate space id: ${space.id}`);
    ids.add(space.id);

    if (!space.label.trim()) throw new Error(`Space ${space.id} must have a display name`);
    if (!/^\/[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/.test(space.path)) {
      throw new Error(`Invalid route path for space ${space.id}: ${space.path}`);
    }
    if (paths.has(space.path)) throw new Error(`Duplicate space route: ${space.path}`);
    paths.add(space.path);

    if (space.status !== 'active' && space.status !== 'inactive') {
      throw new Error(`Invalid status for space ${space.id}: ${space.status}`);
    }
  }
}

export function activeSpaces(registry: readonly SpaceDefinition[] = spaces): readonly SpaceDefinition[] {
  validateSpaceRegistry(registry);
  return registry.filter(space => space.status === 'active');
}

/** Match a space root and its nested pages without matching similarly named paths. */
export function spaceIsCurrentPath(pathname: string, spacePath: string): boolean {
  const current = pathname.replace(/\/+$/, '') || '/';
  const root = spacePath.replace(/\/+$/, '') || '/';
  return current === root || current.startsWith(`${root}/`);
}
