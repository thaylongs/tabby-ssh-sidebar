import { Component, OnInit, OnDestroy, HostBinding, HostListener, ViewChild, ElementRef } from '@angular/core'
import {
    ProfilesService,
    AppService,
    ConfigService,
    TranslateService,
    Profile,
    PartialProfile,
    BaseComponent,
    PlatformService,
    HostAppService,
    HostWindowService,
    Platform,
} from 'tabby-core'
import { SSHProfile } from 'tabby-ssh'
import { Subject } from 'rxjs'
import { takeUntil, debounceTime } from 'rxjs/operators'
import { ProfileActionsService } from '../services/profileActions.service'
import {
    DragItem,
    Folder,
    TreeRow,
    UNGROUPED_ID,
    buildFolderTree,
    canDrop,
    collectProfiles,
    findFolder,
    flattenTree,
    getPathIds,
    loadCollapsedState,
    saveCollapsedState,
} from '../tree/profileTree'
import template from './sshSidebar.component.html'
import styles from './sshSidebar.component.css'

interface ContextMenuPosition {
    x: number
    y: number
}

/**
 * Persistent sidebar listing SSH connections in Tabby's (nested) profile
 * groups, with MobaXterm-style management: connections and folders are
 * created, moved and edited right from the tree.
 *
 * The tree itself is built by `tree/profileTree`, and every change to
 * profiles and groups goes through `ProfileActionsService`; this component
 * only holds the UI state (filter, sort, menus, drag and drop).
 */
@Component({
    selector: 'ssh-sidebar',
    template,
    styles: [styles],
})
export class SSHSidebarComponent extends BaseComponent implements OnInit, OnDestroy {
    @HostBinding('class.ssh-sidebar') hostClass = true

    sshProfiles: PartialProfile<SSHProfile>[] = []
    /** Top-level folders: Favorites, Ungrouped, then Tabby's root groups */
    rootFolders: Folder[] = []
    /** The tree flattened into the lines currently on screen */
    rows: TreeRow[] = []
    filter = ''
    collapsed = false
    sortBy: 'name' | 'host' | 'recent' = 'name'
    pinnedProfiles: string[] = [] // Array of profile IDs

    // Context menu state
    contextMenuVisible = false
    contextMenuPosition: ContextMenuPosition = { x: 0, y: 0 }
    contextMenuKind: 'profile' | 'folder' | 'root' = 'profile'
    contextMenuProfile: PartialProfile<SSHProfile> | null = null
    contextMenuFolder: Folder | null = null
    @ViewChild('contextMenu') contextMenuElement?: ElementRef<HTMLElement>

    // Drag and drop state. `dropTarget` is the folder under the pointer, or
    // 'root' for the empty area of the list.
    dragItem: DragItem | null = null
    dropTarget: Folder | 'root' | null = null
    private dragExpandTimer: any = null

    private destroy$ = new Subject<void>()
    public sidebarService: any = null  // Will be injected by the service

    constructor(
        private profiles: ProfilesService,
        private app: AppService,
        private config: ConfigService,
        private translate: TranslateService,
        private platform: PlatformService,
        private hostApp: HostAppService,
        private hostWindow: HostWindowService,
        private actions: ProfileActionsService,
    ) {
        super()
    }

    /**
     * Whether the sidebar needs to leave room for the macOS window controls.
     *
     * Matches the condition Tabby itself uses for `profile-tree.mac-inset`:
     * the traffic lights only overlap the content when running on macOS with
     * the thin frame and not in fullscreen. In every other case (Windows,
     * Linux, fullscreen, or the full/native frame) no offset is wanted.
     */
    get isMacInset(): boolean {
        return this.hostApp.platform === Platform.macOS
            && !this.hostWindow.isFullscreen
            && this.config.store.appearance?.frame === 'thin'
    }

    @HostListener('document:click', ['$event'])
    onDocumentClick(event: MouseEvent): void {
        // Close context menu when clicking outside
        this.contextMenuVisible = false
    }

    async ngOnInit(): Promise<void> {
        this.loadPinnedProfiles()

        await this.refreshProfiles()

        // Watch for config changes (profiles and groups added/deleted/modified),
        // debounced to avoid multiple rapid refreshes
        this.config.changed$
            .pipe(
                takeUntil(this.destroy$),
                debounceTime(300)
            )
            .subscribe(() => this.refreshProfiles())

        // Watch for tab changes to update active connection indicators
        this.app.tabsChanged$
            .pipe(takeUntil(this.destroy$))
            .subscribe(() => {
                // Force change detection for active state
            })

        // Load collapsed state from config
        const pluginConfig = this.config.store.pluginConfig?.['ssh-sidebar'] || {}
        this.collapsed = pluginConfig.sidebarCollapsed || false
    }

    ngOnDestroy(): void {
        clearTimeout(this.dragExpandTimer)
        this.destroy$.next()
        this.destroy$.complete()
    }

    async refreshProfiles(): Promise<void> {
        const allProfiles = await this.profiles.getProfiles()
        this.sshProfiles = allProfiles.filter(p => {
            // Only include SSH profiles
            if (p.type !== 'ssh') {
                return false
            }

            // Exclude template profiles
            if (p.isTemplate) {
                return false
            }

            // Exclude profiles without a host
            const sshProfile = p as PartialProfile<SSHProfile>
            if (!sshProfile.options?.host) {
                return false
            }

            return true
        }) as PartialProfile<SSHProfile>[]
        await this.refreshProfileGroups()
    }

    /** Rebuilds the folder tree from `sshProfiles` and the config's groups */
    async refreshProfileGroups(): Promise<void> {
        await this.sortProfiles()
        this.rootFolders = buildFolderTree(
            this.sshProfiles,
            this.actions.groups,
            p => this.isProfilePinned(p),
            loadCollapsedState(),
        )
        this.rebuildRows()
    }

    rebuildRows(): void {
        this.rows = flattenTree(this.rootFolders, this.filter ? p => this.isProfileVisible(p) : undefined)
    }

    async sortProfiles(): Promise<void> {
        if (this.sortBy === 'recent') {
            // Use Tabby's built-in recent profiles tracking
            const recentProfiles = await this.profiles.getRecentProfiles()
            const recentIds = recentProfiles.map(p => p.id)

            this.sshProfiles.sort((a, b) => {
                // Active connections always come first
                const aActive = this.isActiveConnection(a)
                const bActive = this.isActiveConnection(b)
                if (aActive && !bActive) return -1
                if (!aActive && bActive) return 1

                // Then sort by Tabby's recent profiles order
                const aIndex = recentIds.indexOf(a.id)
                const bIndex = recentIds.indexOf(b.id)

                if (aIndex !== -1 && bIndex !== -1) {
                    return aIndex - bIndex
                }
                if (aIndex !== -1) return -1
                if (bIndex !== -1) return 1
                return a.name.localeCompare(b.name)
            })
        } else {
            // Synchronous sorting for name and host
            this.sshProfiles.sort((a, b) => {
                switch (this.sortBy) {
                    case 'name':
                        return a.name.localeCompare(b.name)
                    case 'host':
                        const hostA = a.options?.host || ''
                        const hostB = b.options?.host || ''
                        return hostA.localeCompare(hostB)
                    default:
                        return 0
                }
            })
        }
    }

    async setSortOrder(sortBy: 'name' | 'host' | 'recent'): Promise<void> {
        this.sortBy = sortBy
        await this.refreshProfileGroups()
    }

    refreshFilteredProfiles(): void {
        this.rebuildRows()
    }

    isProfileVisible(profile: PartialProfile<Profile>): boolean {
        if (!this.filter) {
            return true
        }
        const searchText = (profile.name + '$' + (this.getDescription(profile) ?? '')).toLowerCase()
        return searchText.includes(this.filter.toLowerCase())
    }

    getDescription(profile: PartialProfile<Profile>): string | null {
        // Try to use ProfilesService method if available, otherwise construct manually
        if (this.profiles.getDescription) {
            return this.profiles.getDescription(profile)
        }

        // Fallback: construct description for SSH profiles
        const sshProfile = profile as PartialProfile<SSHProfile>
        if (sshProfile.options) {
            const user = sshProfile.options.user || 'root'
            const host = sshProfile.options.host || 'unknown'
            const port = sshProfile.options.port || 22
            return `${user}@${host}${port !== 22 ? ':' + port : ''}`
        }
        return null
    }

    toggleFolder(folder: Folder): void {
        // While searching every folder on a match's path is forced open, so
        // flipping the saved state would have no visible effect.
        if (this.filter) {
            return
        }
        folder.collapsed = !folder.collapsed
        saveCollapsedState({ [folder.id]: folder.collapsed })
        this.rebuildRows()
    }

    /** Width of the indent guides in front of a row */
    indent(depth: number): number {
        return depth * 14
    }

    trackRow(_index: number, row: TreeRow): string {
        return row.key
    }

    getFolderIcon(folder: Folder, expanded: boolean): string {
        return folder.icon ?? (expanded ? 'far fa-folder-open' : 'far fa-folder')
    }

    hasContents(folder: Folder): boolean {
        return folder.profiles.length > 0 || folder.children.length > 0
    }

    /** Whether any profile in the folder or its subfolders has an open tab */
    hasActiveConnection(folder: Folder): boolean {
        return folder.profiles.some(p => this.isActiveConnection(p))
            || folder.children.some(c => this.hasActiveConnection(c))
    }

    launchProfile(profile: PartialProfile<Profile>): void {
        if (this.profiles.openNewTabForProfile) {
            this.profiles.openNewTabForProfile(profile)
        } else {
            // Fallback to launchProfile method
            (this.profiles as any).launchProfile(profile)
        }
    }

    isActiveConnection(profile: PartialProfile<SSHProfile>): boolean {
        // Check if there's an active tab with this profile
        return this.app.tabs.some(tab => {
            const tabProfile = (tab as any).profile
            return tabProfile &&
                   tabProfile.type === 'ssh' &&
                   tabProfile.id === profile.id
        })
    }

    isProfileBlacklisted(profile: PartialProfile<Profile>): boolean {
        return profile.id && this.config.store.profileBlacklist.includes(profile.id)
    }

    get activeCount(): number {
        return this.sshProfiles.filter(p => this.isActiveConnection(p)).length
    }

    getConnectionCountText(): string {
        const total = this.sshProfiles.length
        const active = this.activeCount

        if (active === 0) {
            return `${total} connection${total !== 1 ? 's' : ''}`
        }
        return `${total} connection${total !== 1 ? 's' : ''} (${active} active)`
    }

    toggleCollapse(): void {
        // If the service is available, use it to hide the sidebar completely
        if (this.sidebarService) {
            this.sidebarService.hide()
        } else {
            // Fallback: just collapse internally
            this.collapsed = !this.collapsed

            // Save state to config
            const pluginConfig = this.config.store.pluginConfig || {}
            if (!pluginConfig['ssh-sidebar']) {
                pluginConfig['ssh-sidebar'] = {}
            }
            pluginConfig['ssh-sidebar'].sidebarCollapsed = this.collapsed
            this.config.store.pluginConfig = pluginConfig
            this.config.save()
        }
    }

    // Context menus

    onProfileContextMenu(event: MouseEvent, profile: PartialProfile<SSHProfile>): void {
        this.contextMenuProfile = profile
        this.openContextMenu(event, 'profile')
    }

    onFolderContextMenu(event: MouseEvent, folder: Folder): void {
        this.contextMenuFolder = folder
        this.openContextMenu(event, 'folder')
    }

    /** Right-click on the empty area below the tree */
    onListContextMenu(event: MouseEvent): void {
        this.openContextMenu(event, 'root')
    }

    private openContextMenu(event: MouseEvent, kind: 'profile' | 'folder' | 'root'): void {
        event.preventDefault()
        event.stopPropagation()

        this.contextMenuKind = kind
        this.contextMenuPosition = {
            x: event.clientX,
            y: event.clientY,
        }
        this.contextMenuVisible = true

        // Once rendered, pull the menu back inside the window if it would
        // spill past the right or bottom edge.
        setTimeout(() => {
            const menu = this.contextMenuElement?.nativeElement
            if (!menu) {
                return
            }
            const rect = menu.getBoundingClientRect()
            this.contextMenuPosition = {
                x: Math.max(0, Math.min(this.contextMenuPosition.x, window.innerWidth - rect.width - 4)),
                y: Math.max(0, Math.min(this.contextMenuPosition.y, window.innerHeight - rect.height - 4)),
            }
        })
    }

    // Folder actions

    /** New connection, in `folder` when given (from its context menu) */
    async newConnection(folder?: Folder): Promise<void> {
        this.contextMenuVisible = false
        const groupId = folder && (folder.kind === 'group' || folder.kind === 'unknown') ? folder.id : ''
        const created = await this.actions.newConnection(groupId)
        if (created) {
            await this.afterChange(created.group || UNGROUPED_ID)
        }
    }

    /** New folder, inside `parent` when it is a real group, else at the top level */
    async newFolder(parent?: Folder): Promise<void> {
        this.contextMenuVisible = false
        const parentId = parent?.kind === 'group' ? parent.id : undefined
        if (await this.actions.newFolder(parentId)) {
            await this.afterChange(parentId)
        }
    }

    async renameFolder(folder: Folder): Promise<void> {
        this.contextMenuVisible = false
        if (await this.actions.renameFolder(folder.id)) {
            await this.refreshProfiles()
        }
    }

    async editFolder(folder: Folder): Promise<void> {
        this.contextMenuVisible = false
        if (await this.actions.editFolder(folder.id)) {
            await this.refreshProfiles()
        }
    }

    async deleteFolder(folder: Folder): Promise<void> {
        this.contextMenuVisible = false
        if (await this.actions.deleteFolder(folder.id)) {
            await this.refreshProfiles()
        }
    }

    /** Opens a tab for every connection in the folder and its subfolders */
    async openAllConnections(folder: Folder): Promise<void> {
        this.contextMenuVisible = false

        const profiles = collectProfiles(folder)
        if (profiles.length > 5) {
            const result = await this.platform.showMessageBox({
                type: 'warning',
                message: `Open ${profiles.length} connections from "${folder.name}"?`,
                buttons: ['Open All', 'Cancel'],
                defaultId: 0,
                cancelId: 1,
            })
            if (result.response !== 0) {
                return
            }
        }
        for (const profile of profiles) {
            this.launchProfile(profile)
        }
    }

    /** Expands or collapses the given folders and everything below them */
    setFoldersCollapsed(folders: Folder[], collapsed: boolean): void {
        this.contextMenuVisible = false

        const changes: Record<string, boolean> = {}
        const visit = (f: Folder): void => {
            f.collapsed = collapsed
            changes[f.id] = collapsed
            f.children.forEach(visit)
        }
        folders.forEach(visit)
        saveCollapsedState(changes)
        this.rebuildRows()
    }

    /**
     * Refreshes after a change, first opening `revealId` (a folder id) and
     * every folder above it so whatever just landed there is in view.
     */
    private async afterChange(revealId?: string): Promise<void> {
        if (revealId) {
            const changes: Record<string, boolean> = {}
            for (const id of getPathIds(revealId, this.actions.groups)) {
                changes[id] = false
            }
            saveCollapsedState(changes)
        }
        await this.refreshProfiles()
    }

    // Drag and drop
    //
    // Profiles can be dropped on any folder, or on a profile row (meaning the
    // folder it is listed in). Folders can be dropped on another group, or on
    // Ungrouped or the empty area of the list to move them to the top level.
    // See canDrop() for the rules.

    onDragStart(event: DragEvent, item: DragItem): void {
        if (item.folder && item.folder.kind !== 'group') {
            event.preventDefault()
            return
        }
        event.stopPropagation()
        this.contextMenuVisible = false
        this.dragItem = item
        if (event.dataTransfer) {
            event.dataTransfer.effectAllowed = 'move'
            event.dataTransfer.setData('text/plain', (item.profile ?? item.folder)!.name)
        }
    }

    onDragOver(event: DragEvent, target: Folder | null | undefined): void {
        if (!this.dragItem || target === undefined) {
            return
        }
        event.stopPropagation()
        if (!this.canDropOn(this.dragItem, target)) {
            this.setDropTarget(null)
            return
        }
        event.preventDefault()
        if (event.dataTransfer) {
            event.dataTransfer.dropEffect = 'move'
        }
        this.setDropTarget(target ?? 'root')
    }

    onListDragLeave(event: DragEvent): void {
        const list = event.currentTarget as HTMLElement
        if (!list.contains(event.relatedTarget as Node)) {
            this.setDropTarget(null)
        }
    }

    async onDrop(event: DragEvent, target: Folder | null | undefined): Promise<void> {
        const item = this.dragItem
        this.onDragEnd()
        if (!item || target === undefined || !this.canDropOn(item, target)) {
            return
        }
        event.preventDefault()
        event.stopPropagation()

        if (item.profile) {
            await this.dropProfile(item.profile, target)
        } else if (item.folder) {
            const parentId = target?.kind === 'group' ? target.id : undefined
            await this.actions.moveFolder(item.folder.id, parentId)
            await this.afterChange(parentId)
        }
    }

    onDragEnd(): void {
        this.dragItem = null
        this.setDropTarget(null)
    }

    private canDropOn(item: DragItem, target: Folder | null): boolean {
        return canDrop(item, target, this.actions.groups, p => this.isProfilePinned(p))
    }

    /**
     * Highlights the drop target and, when it is a collapsed folder the
     * pointer rests on, opens it after a moment so deeper folders can be reached.
     */
    private setDropTarget(target: Folder | 'root' | null): void {
        if (target === this.dropTarget) {
            return
        }
        this.dropTarget = target
        clearTimeout(this.dragExpandTimer)
        this.dragExpandTimer = null
        if (target && target !== 'root' && target.collapsed && this.hasContents(target) && !this.filter) {
            this.dragExpandTimer = setTimeout(() => {
                if (this.dropTarget === target && target.collapsed) {
                    this.toggleFolder(target)
                }
            }, 700)
        }
    }

    /** Dropping on Favorites pins; dropping anywhere else unpins and moves */
    private async dropProfile(profile: PartialProfile<SSHProfile>, target: Folder | null): Promise<void> {
        if (target?.kind === 'favorites') {
            this.setPinned(profile, true)
            await this.refreshProfileGroups()
            return
        }
        this.setPinned(profile, false)
        const groupId = target && target.kind !== 'ungrouped' ? target.id : undefined
        await this.actions.moveProfile(profile, groupId)
        await this.afterChange(groupId ?? UNGROUPED_ID)
    }

    // Profile context menu

    contextMenuLaunch(): void {
        if (this.contextMenuProfile) {
            this.launchProfile(this.contextMenuProfile)
        }
        this.contextMenuVisible = false
    }

    async contextMenuEdit(): Promise<void> {
        this.contextMenuVisible = false
        if (this.contextMenuProfile && await this.actions.editProfile(this.contextMenuProfile)) {
            await this.refreshProfiles()
        }
    }

    async contextMenuDuplicate(): Promise<void> {
        this.contextMenuVisible = false
        if (this.contextMenuProfile) {
            await this.actions.duplicateProfile(this.contextMenuProfile)
            await this.refreshProfiles()
        }
    }

    contextMenuCopySSHCommand(): void {
        if (!this.contextMenuProfile) {
            this.contextMenuVisible = false
            return
        }

        const profile = this.contextMenuProfile
        const user = profile.options?.user || 'root'
        const host = profile.options?.host || 'unknown'
        const port = profile.options?.port || 22

        let command = `ssh ${user}@${host}`
        if (port !== 22) {
            command += ` -p ${port}`
        }

        // Copy to clipboard
        this.platform.setClipboard({ text: command })

        this.contextMenuVisible = false
    }

    contextMenuBlacklist(): void {
        if (this.contextMenuProfile && this.contextMenuProfile.id) {
            this.config.store.profileBlacklist = [...this.config.store.profileBlacklist, this.contextMenuProfile.id]
            this.config.save()
        }
        this.contextMenuVisible = false
    }

    contextMenuUnblacklist(): void {
        if (this.contextMenuProfile && this.contextMenuProfile.id) {
            this.config.store.profileBlacklist = this.config.store.profileBlacklist.filter(x => x !== this.contextMenuProfile!.id)
            this.config.save()
        }
        this.contextMenuVisible = false
    }

    async contextMenuDelete(): Promise<void> {
        this.contextMenuVisible = false
        if (this.contextMenuProfile && await this.actions.deleteProfile(this.contextMenuProfile)) {
            await this.refreshProfiles()
        }
    }

    async contextMenuPin(): Promise<void> {
        this.contextMenuVisible = false
        if (this.contextMenuProfile?.id) {
            this.setPinned(this.contextMenuProfile, true)
            await this.refreshProfileGroups()
        }
    }

    async contextMenuUnpin(): Promise<void> {
        this.contextMenuVisible = false
        if (this.contextMenuProfile?.id) {
            this.setPinned(this.contextMenuProfile, false)
            await this.refreshProfileGroups()
        }
    }

    isProfilePinned(profile: PartialProfile<SSHProfile>): boolean {
        return profile.id ? this.pinnedProfiles.includes(profile.id) : false
    }

    private setPinned(profile: PartialProfile<SSHProfile>, pinned: boolean): void {
        if (!profile.id || this.isProfilePinned(profile) === pinned) {
            return
        }
        this.pinnedProfiles = pinned
            ? [...this.pinnedProfiles, profile.id]
            : this.pinnedProfiles.filter(id => id !== profile.id)
        this.savePinnedProfiles()
    }

    private savePinnedProfiles(): void {
        const pluginConfig = this.config.store.pluginConfig?.['ssh-sidebar'] || {}
        pluginConfig.pinnedProfiles = this.pinnedProfiles
        if (!this.config.store.pluginConfig) {
            this.config.store.pluginConfig = {}
        }
        this.config.store.pluginConfig['ssh-sidebar'] = pluginConfig
        this.config.save()
    }

    private loadPinnedProfiles(): void {
        const pluginConfig = this.config.store.pluginConfig?.['ssh-sidebar'] || {}
        this.pinnedProfiles = pluginConfig.pinnedProfiles || []
    }
}
