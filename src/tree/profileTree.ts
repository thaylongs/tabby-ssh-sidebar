/**
 * The sidebar's folder tree: building it from Tabby's profile groups,
 * flattening it into on-screen rows, and the rules for dragging things
 * around in it. Plain functions over plain data, no Angular.
 */
import { PartialProfile } from 'tabby-core'
import { SSHProfile } from 'tabby-ssh'

/**
 * A profile group as stored in `config.store.groups`. Tabby 1.0.236 nests
 * groups through `parentGroupId`, but the newest typings on npm
 * (1.0.231-nightly.0) predate it, hence the local shape.
 */
export interface ConfigGroup {
    id: string
    name: string
    parentGroupId?: string
    icon?: string
    color?: string
    defaults?: any
}

/**
 * A folder in the sidebar tree: a Tabby group, or one of the sidebar's own
 * pseudo-folders (Favorites, Ungrouped).
 */
export interface Folder {
    id: string
    /**
     * `group`: a real Tabby group, which can be renamed, moved and nested.
     * `unknown`: a profile's group id with no matching group (e.g. a
     * pre-migration name-based group), which only holds profiles.
     */
    kind: 'group' | 'favorites' | 'ungrouped' | 'unknown'
    name: string
    icon?: string
    color?: string
    profiles: PartialProfile<SSHProfile>[]
    children: Folder[]
    /** SSH profiles in this folder and all of its subfolders */
    total: number
    collapsed: boolean
}

/** One visible line of the flattened tree */
export interface TreeRow {
    key: string
    depth: number
    folder?: Folder
    expanded?: boolean
    /** Profiles shown under the folder: all of them, or only matches while searching */
    count?: number
    profile?: PartialProfile<SSHProfile>
    /** For a profile row, the folder it is listed in */
    parent?: Folder
}

/** What is being dragged: a profile, or a folder backed by a real group */
export interface DragItem {
    profile?: PartialProfile<SSHProfile>
    folder?: Folder
}

export const FAVORITES_ID = 'favorites'
export const UNGROUPED_ID = 'ungrouped'

/**
 * Builds the folder tree.
 *
 * `profiles` must already be sorted: they are distributed into their
 * folders in that order, so every folder ends up sorted the same way.
 * Pinned profiles move to Favorites and leave their folder. Every Tabby
 * group is listed, even an empty one, so folders can be set up before any
 * connection goes in them. Ungrouped is always there too, as the top level
 * things can be dropped on; Favorites only shows up once something is pinned.
 */
export function buildFolderTree(
    profiles: PartialProfile<SSHProfile>[],
    groups: ConfigGroup[],
    isPinned: (profile: PartialProfile<SSHProfile>) => boolean,
    collapsedState: Record<string, boolean>,
): Folder[] {
    const makeFolder = (id: string, kind: Folder['kind'], name: string, extra: Partial<Folder> = {}): Folder => ({
        id,
        kind,
        name,
        profiles: [],
        children: [],
        total: 0,
        collapsed: collapsedState[id] ?? false,
        ...extra,
    })

    const folders = new Map<string, Folder>()
    for (const group of groups) {
        folders.set(group.id, makeFolder(group.id, 'group', group.name, { icon: group.icon, color: group.color }))
    }

    const favorites = makeFolder(FAVORITES_ID, 'favorites', 'Favorites', { icon: 'fas fa-star', color: '#f5c518' })
    const ungrouped = makeFolder(UNGROUPED_ID, 'ungrouped', 'Ungrouped')
    const unknownGroups: Folder[] = []

    for (const profile of profiles) {
        if (isPinned(profile)) {
            favorites.profiles.push(profile)
            continue
        }
        if (!profile.group) {
            ungrouped.profiles.push(profile)
            continue
        }
        let folder = folders.get(profile.group)
        if (!folder) {
            folder = makeFolder(profile.group, 'unknown', profile.group)
            folders.set(profile.group, folder)
            unknownGroups.push(folder)
        }
        folder.profiles.push(profile)
    }

    const roots: Folder[] = [...unknownGroups]
    for (const group of groups) {
        const folder = folders.get(group.id)!
        const parent = hasValidParent(group, groups) ? folders.get(group.parentGroupId!) : undefined
        if (parent) {
            parent.children.push(folder)
        } else {
            roots.push(folder)
        }
    }

    const byName = (a: Folder, b: Folder) => a.name.localeCompare(b.name, undefined, { numeric: true })
    const finish = (folder: Folder): boolean => {
        folder.children = folder.children.filter(finish).sort(byName)
        folder.total = folder.profiles.length + folder.children.reduce((sum, c) => sum + c.total, 0)
        return folder.kind === 'group' || folder.kind === 'ungrouped' || folder.total > 0
    }

    return [favorites, ungrouped, ...roots.sort(byName)].filter(finish)
}

/**
 * Flattens the tree into rows. Without `match`, collapsed folders hide
 * their contents and empty folders are listed too. With it, only matching
 * profiles are listed, every folder on the way to them is shown open
 * (without touching its saved collapse state), and folders with no match
 * are left out.
 */
export function flattenTree(roots: Folder[], match?: (profile: PartialProfile<SSHProfile>) => boolean): TreeRow[] {
    const visit = (folder: Folder, depth: number): { rows: TreeRow[], count: number } => {
        const profiles = match ? folder.profiles.filter(match) : folder.profiles
        const children = folder.children.map(child => visit(child, depth + 1))
        const count = match
            ? profiles.length + children.reduce((sum, c) => sum + c.count, 0)
            : folder.total
        if (match && count === 0) {
            return { rows: [], count }
        }

        const expanded = !!match || !folder.collapsed
        const rows: TreeRow[] = [{ key: `f:${folder.id}`, depth, folder, expanded, count }]
        if (expanded) {
            for (const child of children) {
                rows.push(...child.rows)
            }
            for (const profile of profiles) {
                rows.push({ key: `p:${folder.id}:${profile.id ?? profile.name}`, depth: depth + 1, profile, parent: folder })
            }
        }
        return { rows, count }
    }

    const rows: TreeRow[] = []
    for (const folder of roots) {
        rows.push(...visit(folder, 0).rows)
    }
    return rows
}

/**
 * Whether a group's parent exists and following parents from it never
 * loops back. A group whose chain is broken or circular is shown at the
 * top level instead of disappearing.
 */
export function hasValidParent(group: ConfigGroup, groups: ConfigGroup[]): boolean {
    const seen = new Set<string>([group.id])
    let parentId = group.parentGroupId
    while (parentId) {
        if (seen.has(parentId)) {
            return false
        }
        seen.add(parentId)
        const parent = groups.find(g => g.id === parentId)
        if (!parent) {
            return false
        }
        parentId = parent.parentGroupId
    }
    return !!group.parentGroupId
}

/** The group and all of its descendants */
export function getSubtreeGroupIds(id: string, groups: ConfigGroup[]): Set<string> {
    const ids = new Set<string>([id])
    let grew = true
    while (grew) {
        grew = false
        for (const g of groups) {
            if (g.parentGroupId && ids.has(g.parentGroupId) && !ids.has(g.id)) {
                ids.add(g.id)
                grew = true
            }
        }
    }
    return ids
}

/** The folder itself and the ids of every group above it */
export function getPathIds(id: string, groups: ConfigGroup[]): string[] {
    const ids = [id]
    let group = groups.find(g => g.id === id)
    while (group?.parentGroupId && !ids.includes(group.parentGroupId)) {
        ids.push(group.parentGroupId)
        group = groups.find(g => g.id === group!.parentGroupId)
    }
    return ids
}

export function findFolder(roots: Folder[], id: string): Folder | undefined {
    for (const folder of roots) {
        const found = folder.id === id ? folder : findFolder(folder.children, id)
        if (found) {
            return found
        }
    }
    return undefined
}

/** Every profile in the folder and its subfolders */
export function collectProfiles(folder: Folder): PartialProfile<SSHProfile>[] {
    return [...folder.profiles, ...folder.children.flatMap(collectProfiles)]
}

/**
 * Whether `item` may be dropped on `target` (`null` being the empty area
 * of the list, i.e. the top level).
 *
 * Profiles can go in any folder: dropping on Favorites pins, dropping
 * anywhere else unpins and moves. Folders move under another group, or to
 * the top level via Ungrouped or the empty area, but never into themselves
 * or their own subfolders. Drops that would change nothing are refused.
 */
export function canDrop(
    item: DragItem,
    target: Folder | null,
    groups: ConfigGroup[],
    isPinned: (profile: PartialProfile<SSHProfile>) => boolean,
): boolean {
    if (item.profile) {
        const pinned = isPinned(item.profile)
        if (!target) {
            return !!item.profile.group || pinned
        }
        if (target.kind === 'favorites') {
            return !!item.profile.id && !pinned
        }
        const targetGroup = target.kind === 'ungrouped' ? '' : target.id
        return pinned || (item.profile.group ?? '') !== targetGroup
    }
    if (item.folder) {
        const group = groups.find(g => g.id === item.folder!.id)
        if (!group) {
            return false
        }
        if (!target || target.kind === 'ungrouped') {
            return !!group.parentGroupId
        }
        if (target.kind !== 'group') {
            return false
        }
        return !getSubtreeGroupIds(group.id, groups).has(target.id) && group.parentGroupId !== target.id
    }
    return false
}

/**
 * Folder collapse state, shared with Tabby's own profile tree, which keeps
 * it under the same localStorage key.
 */
export function loadCollapsedState(): Record<string, boolean> {
    try {
        return JSON.parse(window.localStorage.profileGroupCollapsed ?? '{}')
    } catch {
        return {}
    }
}

export function saveCollapsedState(changes: Record<string, boolean>): void {
    window.localStorage.profileGroupCollapsed = JSON.stringify({ ...loadCollapsedState(), ...changes })
}
