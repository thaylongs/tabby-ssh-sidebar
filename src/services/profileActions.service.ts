import { Injectable, Inject } from '@angular/core'
import { NgbModal } from '@ng-bootstrap/ng-bootstrap'
import {
    ConfigService,
    PartialProfile,
    PlatformService,
    Profile,
    ProfileProvider,
    ProfilesService,
    PromptModalComponent,
    TranslateService,
} from 'tabby-core'
import deepClone from 'clone-deep'
import { ConfigGroup, getSubtreeGroupIds } from '../tree/profileTree'

/**
 * Everything the sidebar does to Tabby's profiles and groups: creating,
 * editing, moving and deleting them, and the dialogs that go with it.
 *
 * Each method saves the config when it changes something and resolves to
 * whether it did, so the caller knows when to refresh. Editors are Tabby's
 * own modals from tabby-settings, the same ones its settings tab and
 * profile tree use.
 */
@Injectable({ providedIn: 'root' })
export class ProfileActionsService {
    constructor(
        private profiles: ProfilesService,
        private config: ConfigService,
        private translate: TranslateService,
        private platform: PlatformService,
        private ngbModal: NgbModal,
        @Inject(ProfileProvider) private profileProviders: ProfileProvider<Profile>[],
    ) {}

    get groups(): ConfigGroup[] {
        return this.config.store.groups ?? []
    }

    findGroup(id: string): ConfigGroup | undefined {
        return this.groups.find(g => g.id === id)
    }

    // Profiles

    /**
     * Opens the profile editor for a new SSH connection, starting from the
     * SSH template and placed in `groupId` (empty for no group). Resolves to
     * the created profile, or null if cancelled.
     */
    async newConnection(groupId: string): Promise<PartialProfile<Profile> | null> {
        const allProfiles = await this.profiles.getProfiles({ includeBuiltin: true })
        const template = allProfiles.find(p => p.type === 'ssh' && p.isTemplate)
        const base: PartialProfile<Profile> = template ? deepClone(template) : { type: 'ssh', name: '', options: {} }
        delete base.id
        base.name = ''
        base.isBuiltin = false
        base.isTemplate = false
        base.group = groupId

        const result = await this.showProfileEditModal(base)
        if (!result) {
            return null
        }
        if (!result.name) {
            const provider = this.profiles.providerForProfile(result)
            result.name = provider?.getSuggestedName(this.profiles.getConfigProxyForProfile(result))
                ?? (result.options?.host || this.translate.instant('New connection'))
        }

        await this.profiles.newProfile(result)
        await this.config.save()
        return result
    }

    async editProfile(profile: PartialProfile<Profile>): Promise<boolean> {
        if (profile.isBuiltin) {
            return false
        }
        const result = await this.showProfileEditModal(profile)
        if (!result) {
            return false
        }

        if (profile.id) {
            await this.profiles.writeProfile(result)
        } else {
            // An id-less profile written by 0.4.0 or earlier: writeProfile()
            // matches by id and would find nothing, so replace it in place
            // and give it a proper id while at it.
            const stored = this.config.store.profiles as PartialProfile<Profile>[]
            const index = stored.indexOf(profile)
            if (index === -1) {
                return false
            }
            result.id = this.generateProfileId(result)
            stored[index] = result
        }
        await this.config.save()
        return true
    }

    async duplicateProfile(profile: PartialProfile<Profile>): Promise<void> {
        const baseProfile: PartialProfile<Profile> = deepClone(profile)
        delete baseProfile.id
        baseProfile.name = this.translate.instant('{name} copy', profile)
        baseProfile.isBuiltin = false
        baseProfile.isTemplate = false

        this.config.store.profiles = this.config.store.profiles || []

        // Hand off to Tabby so the copy gets a real id. Tabby matches profiles by
        // `id` almost everywhere, so a profile without one is not just cosmetically
        // odd -- it is invisible to the profile selector, and any id-based lookup
        // matches *every* id-less profile at once. Duplicating used to push a
        // stripped clone straight into the config, which is exactly how that
        // happened. newProfile() assigns `${type}:custom:${slug}:${uuid}` and
        // pushes the profile itself, so it must not be pushed again here.
        const profiles = this.profiles as any
        if (typeof profiles.newProfile === 'function') {
            await profiles.newProfile(baseProfile)
        } else {
            // Older Tabby without newProfile -- mint an id in the same format
            // rather than leaving the profile without one.
            baseProfile.id = this.generateProfileId(baseProfile)
            this.config.store.profiles.push(baseProfile)
        }

        await this.config.save()
    }

    async deleteProfile(profile: PartialProfile<Profile>): Promise<boolean> {
        if (profile.isBuiltin) {
            return false
        }

        const result = await this.platform.showMessageBox({
            type: 'warning',
            message: this.translate.instant('Delete "{name}"?', profile),
            buttons: [
                this.translate.instant('Delete'),
                this.translate.instant('Cancel'),
            ],
            defaultId: 1,
            cancelId: 1,
        })
        if (result.response !== 0) {
            return false
        }

        // Remove by object identity, not by id. Filtering on `p.id !== target.id`
        // deletes every profile sharing that id -- and `undefined === undefined`,
        // so with any id-less profiles in the config (0.4.0 and earlier created
        // them when duplicating) deleting one wiped out all of them. Identity
        // removes exactly the profile the user right-clicked, and still cleans up
        // the id-less profiles an older version may already have written.
        const index = this.config.store.profiles.indexOf(profile)
        if (index !== -1) {
            this.config.store.profiles.splice(index, 1)
        } else if (profile.id) {
            // Not the same object (e.g. re-read from config) -- fall back to id,
            // which is safe as long as the profile actually has one.
            this.config.store.profiles = this.config.store.profiles.filter(p => p.id !== profile.id)
        }
        await this.config.save()
        return true
    }

    /** Moves a profile into a group, or out of any group when `groupId` is empty */
    async moveProfile(profile: PartialProfile<Profile>, groupId: string | undefined): Promise<void> {
        const stored = this.findConfigProfile(profile)
        if (!stored) {
            return
        }
        setProfileGroup(stored, groupId)
        await this.config.save()
    }

    // Folders

    /** Asks for a name and creates a group under `parentId`, or at the top level */
    async newFolder(parentId?: string): Promise<ConfigGroup | null> {
        const parent = parentId ? this.findGroup(parentId) : undefined
        const name = await this.promptForName(parent ? `New folder in "${parent.name}"` : 'New folder')
        if (!name) {
            return null
        }

        const group: ConfigGroup = { id: '', name }
        if (parent) {
            group.parentGroupId = parent.id
        }
        await this.profiles.newProfileGroup(group as any)
        await this.config.save()
        return group
    }

    /**
     * Renames a group. Subfolders point at their parent by id, not by name,
     * so they follow along without being touched.
     */
    async renameFolder(groupId: string): Promise<boolean> {
        const group = this.findGroup(groupId)
        if (!group) {
            return false
        }
        const name = await this.promptForName('Folder name', group.name)
        if (!name || name === group.name) {
            return false
        }
        group.name = name
        await this.config.save()
        return true
    }

    /**
     * Opens Tabby's group editor: name, parent, icon, color and the
     * per-type defaults applied to the group's profiles.
     */
    async editFolder(groupId: string): Promise<boolean> {
        const current = this.findGroup(groupId)
        if (!current) {
            return false
        }
        const { EditProfileGroupModalComponent } = window['nodeRequire']('tabby-settings')

        let group = deepClone(current)
        // Editing a provider's defaults closes the group editor, so reopen it
        // afterwards until the user saves or cancels it.
        for (;;) {
            const modal = this.ngbModal.open(EditProfileGroupModalComponent, { size: 'lg' })
            modal.componentInstance.group = group
            modal.componentInstance.providers = this.profileProviders
            const result = await modal.result.catch(() => null)
            if (!result?.group) {
                return false
            }
            group = result.group
            if (!result.provider) {
                break
            }
            await this.editFolderDefaults(group, result.provider)
        }

        await this.profiles.writeProfileGroup(group)
        await this.config.save()
        return true
    }

    /**
     * Deletes a group. When it isn't empty the user chooses between moving
     * its contents (connections and subfolders) up to the parent folder, or
     * deleting the whole subtree, connections included.
     */
    async deleteFolder(groupId: string): Promise<boolean> {
        const group = this.findGroup(groupId)
        if (!group) {
            return false
        }
        const subtree = getSubtreeGroupIds(group.id, this.groups)
        // Every profile type counts here, not just SSH: deleting the subtree
        // deletes them too.
        const profileCount = this.config.store.profiles.filter(p => p.group && subtree.has(p.group)).length
        const folderCount = subtree.size - 1

        let deleteContents = false
        if (profileCount === 0 && folderCount === 0) {
            const result = await this.platform.showMessageBox({
                type: 'warning',
                message: `Delete folder "${group.name}"?`,
                buttons: ['Delete', 'Cancel'],
                defaultId: 1,
                cancelId: 1,
            })
            if (result.response !== 0) {
                return false
            }
        } else {
            const parts: string[] = []
            if (profileCount) {
                parts.push(`${profileCount} connection${profileCount !== 1 ? 's' : ''}`)
            }
            if (folderCount) {
                parts.push(`${folderCount} subfolder${folderCount !== 1 ? 's' : ''}`)
            }
            const result = await this.platform.showMessageBox({
                type: 'warning',
                message: `Delete folder "${group.name}"?`,
                detail: `It contains ${parts.join(' and ')}. You can move them to the parent folder, or delete them along with the folder.`,
                buttons: ['Move Contents Up', 'Delete Everything', 'Cancel'],
                defaultId: 2,
                cancelId: 2,
            })
            if (result.response === 2) {
                return false
            }
            deleteContents = result.response === 1
        }

        if (deleteContents) {
            for (const id of subtree) {
                const g = this.findGroup(id)
                if (g) {
                    await this.profiles.deleteProfileGroup(g as any, { deleteProfiles: true })
                }
            }
        } else {
            const parentId = group.parentGroupId && this.findGroup(group.parentGroupId) ? group.parentGroupId : undefined
            for (const child of this.groups.filter(g => g.parentGroupId === group.id)) {
                setParentGroup(child, parentId)
            }
            for (const profile of this.config.store.profiles.filter(p => p.group === group.id)) {
                setProfileGroup(profile, parentId)
            }
            await this.profiles.deleteProfileGroup(group as any)
        }

        await this.config.save()
        return true
    }

    /** Moves a group under another one, or to the top level when `parentId` is empty */
    async moveFolder(groupId: string, parentId: string | undefined): Promise<void> {
        const group = this.findGroup(groupId)
        if (!group) {
            return
        }
        setParentGroup(group, parentId)
        await this.config.save()
    }

    // Helpers

    /**
     * The config entry behind a listed profile. Usually the very same object;
     * matched by id otherwise, which is only safe when it has one.
     */
    private findConfigProfile(profile: PartialProfile<Profile>): PartialProfile<Profile> | undefined {
        const stored = this.config.store.profiles as PartialProfile<Profile>[]
        if (stored.includes(profile)) {
            return profile
        }
        return profile.id ? stored.find(p => p.id === profile.id) : undefined
    }

    private async editFolderDefaults(group: ConfigGroup, provider: ProfileProvider<Profile>): Promise<void> {
        const { EditProfileModalComponent } = window['nodeRequire']('tabby-settings')
        const modal = this.ngbModal.open(EditProfileModalComponent, { size: 'lg' })
        const model = group.defaults?.[provider.id] ?? {}
        model.type = provider.id
        modal.componentInstance.partialProfile = Object.assign({}, model)
        modal.componentInstance.profileProvider = provider
        modal.componentInstance.defaultsMode = 'group'

        const result = await modal.result.catch(() => null)
        if (result) {
            group.defaults = { ...group.defaults, [provider.id]: result }
        }
    }

    private async showProfileEditModal(profile: PartialProfile<Profile>): Promise<PartialProfile<Profile> | null> {
        const provider = this.profiles.providerForProfile(profile)
        if (!provider) {
            return null
        }
        const { EditProfileModalComponent } = window['nodeRequire']('tabby-settings')
        const modal = this.ngbModal.open(EditProfileModalComponent, { size: 'lg' })
        modal.componentInstance.partialProfile = deepClone(profile)
        modal.componentInstance.profileProvider = provider

        const result = await modal.result.catch(() => null)
        if (!result) {
            return null
        }
        result.type = provider.id
        return result
    }

    private async promptForName(prompt: string, value = ''): Promise<string | null> {
        const modal = this.ngbModal.open(PromptModalComponent)
        modal.componentInstance.prompt = prompt
        modal.componentInstance.value = value
        const result = await modal.result.catch(() => null)
        return result?.value?.trim() || null
    }

    /**
     * Builds an id in the same shape Tabby's own `newProfile()` uses, for
     * profiles that end up in the config without going through it.
     */
    private generateProfileId(profile: PartialProfile<Profile>): string {
        const slug = (profile.name ?? 'profile')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '') || 'profile'
        const uuid = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
            ? crypto.randomUUID()
            : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`
        return `${profile.type}:custom:${slug}:${uuid}`
    }
}

function setParentGroup(group: ConfigGroup, parentId: string | undefined): void {
    if (parentId) {
        group.parentGroupId = parentId
    } else {
        delete group.parentGroupId
    }
}

function setProfileGroup(profile: PartialProfile<Profile>, groupId: string | undefined): void {
    if (groupId) {
        profile.group = groupId
    } else {
        delete profile.group
    }
}
