import { Injectable, ComponentFactoryResolver, ApplicationRef, Injector, EmbeddedViewRef, ComponentRef } from '@angular/core'
import { ConfigService } from 'tabby-core'
import { SSHSidebarComponent } from '../components/sshSidebar.component'

/**
 * Service to manage the SSH sidebar panel lifecycle and state
 *
 * The sidebar is inserted into Tabby's `.window` element, which is the
 * horizontal (row) flex container holding `profile-tree` and `.content.main`.
 * `app-root` itself is a *column* flex container (title bar on top, window
 * below), so it must never be turned into a row container - doing so stacks
 * the title bar beside the terminal and collapses the layout.
 */
@Injectable({ providedIn: 'root' })
export class SSHSidebarService {
    private sidebarComponentRef: ComponentRef<SSHSidebarComponent> | null = null
    private sidebarElement: HTMLElement | null = null
    private styleElement: HTMLStyleElement | null = null
    private isVisible = false
    private readonly DEFAULT_WIDTH = 280
    private readonly MIN_WIDTH = 200
    private readonly MAX_WIDTH = 600
    /** Room always left for the terminal, however wide the sidebar is dragged */
    private readonly MIN_CONTENT_WIDTH = 300
    private readonly WIDTH_STORAGE_KEY = 'sshSidebarWidth'
    private width = this.loadWidth()
    private stopResize: (() => void) | null = null

    constructor(
        private componentFactoryResolver: ComponentFactoryResolver,
        private appRef: ApplicationRef,
        private injector: Injector,
        private config: ConfigService,
    ) {}

    show(): void {
        if (this.isVisible) {
            return
        }

        this.createSidebar()

        const pluginConfig = this.config.store.pluginConfig?.['ssh-sidebar'] || {}
        pluginConfig.sidebarVisible = true
        this.saveConfig(pluginConfig)

        this.isVisible = true
    }

    hide(): void {
        if (!this.isVisible) {
            return
        }

        this.destroySidebar()

        const pluginConfig = this.config.store.pluginConfig?.['ssh-sidebar'] || {}
        pluginConfig.sidebarVisible = false
        this.saveConfig(pluginConfig)

        this.isVisible = false
    }

    toggle(): void {
        if (this.isVisible) {
            this.hide()
        } else {
            this.show()
        }
    }

    get visible(): boolean {
        return this.isVisible
    }

    initialize(): void {
        const pluginConfig = this.config.store.pluginConfig?.['ssh-sidebar'] || {}
        // Open sidebar by default on first startup, or if explicitly set to visible
        if (pluginConfig.sidebarVisible !== false) {
            this.show()
        }
    }

    /**
     * Find Tabby's horizontal flex container.
     *
     * Tabby's layout is: app-root (column) > .window (row) > [profile-tree, .content.main]
     * We insert next to `profile-tree` so the sidebar sits in the row flow and the
     * terminal area simply shrinks, without touching any of Tabby's own styles.
     */
    private getWindowContainer(): HTMLElement | null {
        return document.querySelector('app-root .window') as HTMLElement | null
    }

    private createSidebar(): void {
        const container = this.getWindowContainer()
        if (!container) {
            console.error('SSH Sidebar: could not find Tabby\'s .window container')
            return
        }

        // Create component
        const componentFactory = this.componentFactoryResolver.resolveComponentFactory(SSHSidebarComponent)
        this.sidebarComponentRef = componentFactory.create(this.injector)

        // Attach to application
        this.appRef.attachView(this.sidebarComponentRef.hostView)

        // Get DOM element
        const domElem = (this.sidebarComponentRef.hostView as EmbeddedViewRef<any>).rootNodes[0] as HTMLElement

        // Create wrapper that participates in .window's row flex layout
        const wrapper = document.createElement('div')
        wrapper.className = 'ssh-sidebar-wrapper'
        wrapper.style.cssText = `
            position: relative;
            min-width: 0;
            height: 100%;
            overflow: hidden;
            display: flex;
            flex-direction: column;
            background: var(--bs-body-bg, #1e1e1e);
            border-right: 1px solid color-mix(in srgb, var(--bs-body-color, #888) 18%, var(--bs-body-bg, #1e1e1e));
            z-index: 10;
        `

        wrapper.appendChild(domElem)
        wrapper.appendChild(this.createResizeHandle())

        // Insert as the first child of the row container (left of profile-tree/content)
        container.insertBefore(wrapper, container.firstChild)

        this.sidebarElement = wrapper
        this.applyWidth(this.width)

        this.injectLayoutCSS()

        // Inject service reference into component so it can call hide()
        if (this.sidebarComponentRef) {
            const component = this.sidebarComponentRef.instance
            component.sidebarService = this
        }
    }

    private destroySidebar(): void {
        this.stopResize?.()
        this.removeLayoutCSS()

        if (this.sidebarComponentRef) {
            this.appRef.detachView(this.sidebarComponentRef.hostView)
            this.sidebarComponentRef.destroy()
            this.sidebarComponentRef = null
        }

        if (this.sidebarElement) {
            this.sidebarElement.remove()
            this.sidebarElement = null
        }
    }

    /**
     * The drag handle on the sidebar's right edge. Dragging resizes the
     * sidebar (the terminal takes whatever is left), double-clicking
     * restores the default width. The width is kept in localStorage rather
     * than the config so dragging doesn't write config.yaml on every change.
     */
    private createResizeHandle(): HTMLElement {
        const handle = document.createElement('div')
        handle.className = 'ssh-sidebar-resize-handle'
        handle.title = 'Drag to resize, double-click to reset'

        handle.addEventListener('dblclick', () => {
            this.applyWidth(this.DEFAULT_WIDTH)
            this.saveWidth()
        })

        handle.addEventListener('mousedown', (event: MouseEvent) => {
            if (event.button !== 0) {
                return
            }
            event.preventDefault()

            const startX = event.clientX
            const startWidth = this.width
            let frame = 0

            const onMove = (e: MouseEvent) => {
                cancelAnimationFrame(frame)
                frame = requestAnimationFrame(() => this.applyWidth(startWidth + e.clientX - startX))
            }
            const stop = () => {
                cancelAnimationFrame(frame)
                document.removeEventListener('mousemove', onMove)
                document.removeEventListener('mouseup', stop)
                document.body.classList.remove('ssh-sidebar-resizing')
                handle.classList.remove('active')
                this.stopResize = null
                this.saveWidth()
            }

            document.addEventListener('mousemove', onMove)
            document.addEventListener('mouseup', stop)
            // Keeps the resize cursor, and stops text selection, while the
            // pointer is over the terminal rather than the handle
            document.body.classList.add('ssh-sidebar-resizing')
            handle.classList.add('active')
            this.stopResize = stop
        })

        return handle
    }

    private applyWidth(width: number): void {
        const max = Math.min(this.MAX_WIDTH, window.innerWidth - this.MIN_CONTENT_WIDTH)
        this.width = Math.round(Math.max(this.MIN_WIDTH, Math.min(width, max)))
        if (this.sidebarElement) {
            this.sidebarElement.style.width = `${this.width}px`
            this.sidebarElement.style.flex = `0 0 ${this.width}px`
        }
    }

    private loadWidth(): number {
        const stored = parseInt(window.localStorage[this.WIDTH_STORAGE_KEY] ?? '', 10)
        return Number.isFinite(stored) ? stored : this.DEFAULT_WIDTH
    }

    private saveWidth(): void {
        window.localStorage[this.WIDTH_STORAGE_KEY] = String(this.width)
    }

    /**
     * Let the main content area shrink next to the sidebar.
     *
     * Tabby sizes `.content.main` with `width: 100vw`, which in a row flex
     * container refuses to give up space to a sibling. Overriding the flex
     * basis (rather than forcing a width) lets the terminal fill exactly the
     * remaining width.
     *
     * That `100vw` is also the only thing giving `.window` its width: `.window`
     * has no width of its own and is not stretched by `app-root`, so once the
     * override drops it, `.window` shrinks to the size of its content and
     * leaves the rest of the window empty. `.window` is therefore pinned to
     * the full width explicitly.
     */
    private injectLayoutCSS(): void {
        const style = document.createElement('style')
        style.id = 'ssh-sidebar-layout-css'
        style.textContent = `
            app-root > .window {
                width: 100% !important;
                align-self: stretch !important;
            }

            app-root .window > .content.main {
                flex: 1 1 0 !important;
                width: auto !important;
                min-width: 0 !important;
            }

            .ssh-sidebar-resize-handle {
                position: absolute;
                top: 0;
                right: 0;
                width: 5px;
                height: 100%;
                cursor: col-resize;
                z-index: 20;
                transition: background 0.15s ease;
            }

            .ssh-sidebar-resize-handle:hover,
            .ssh-sidebar-resize-handle.active {
                background: var(--bs-primary, #3b82f6);
            }

            body.ssh-sidebar-resizing,
            body.ssh-sidebar-resizing * {
                cursor: col-resize !important;
                user-select: none !important;
            }
        `

        document.head.appendChild(style)
        this.styleElement = style
    }

    private removeLayoutCSS(): void {
        if (this.styleElement) {
            this.styleElement.remove()
            this.styleElement = null
        }
    }

    private saveConfig(pluginConfig: any): void {
        if (!this.config.store.pluginConfig) {
            this.config.store.pluginConfig = {}
        }
        this.config.store.pluginConfig['ssh-sidebar'] = pluginConfig
        this.config.save()
    }
}
