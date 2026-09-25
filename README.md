# Tabby SSH Sidebar

A Tabby Terminal plugin that adds a persistent sidebar panel showing all your SSH connections, with quick access via toolbar button.

> ⚠️ **Disclaimer**: This plugin was made by a monkey who vibes code. Expect it to break and not work as intended. Use at your own risk!

## Screenshots

### Sidebar Overview
![Sidebar with grouped connections and favorites](https://raw.githubusercontent.com/tsukasagenesis/tabby-ssh-sidebar/main/screenshots/sidebar-overview.png)

### Context Menu
![Right-click context menu with connection options](https://raw.githubusercontent.com/tsukasagenesis/tabby-ssh-sidebar/main/screenshots/context-menu.png)

## Features

### Persistent Sidebar Panel
- **Always-Visible Panel**: Fixed sidebar on the left side showing all SSH connections
- **Live Connection Status**: Visual indicators show which connections are currently active
- **Search Functionality**: Built-in search box to filter connections by name, host, or user. Matches are shown inside their folders, opened along the way; folders without matches are hidden
- **Nested Folders**: Mirrors Tabby's hierarchical profile groups (Tabby 1.0.236+) as an indented tree, any number of levels deep, with expand/collapse arrows
- **Connection Counts**: Each folder shows how many connections it holds, subfolders included (or how many match, while searching)
- **Favorites Support**: Pin your most-used connections to a dedicated "Favorites" group at the top
- **Auto-Initialize**: Restores your previous sidebar state on startup
- **Resizable**: Drag the sidebar's right edge to change its width (200–600px); double-click the edge to reset. The width is remembered

### Connection Management
- **Right-Click Context Menu**: Access additional options for each connection
  - Connect to SSH server
  - Edit connection settings (opens Tabby's profile editor)
  - Pin/Unpin from Favorites
  - Delete connection
- **Profile Sorting**: Sort by name, host, or recent use — applied within each folder
- **Group Organization**: Works directly on your Tabby profile groups — every group is listed, even empty ones

### Organizing Like MobaXterm
- **Create From the Sidebar**: The **+** and **folder+** buttons in the header create a connection or a top-level folder. Right-clicking the empty area of the list offers the same, plus expand/collapse all
- **Drag and Drop**: Drag connections between folders (drop on Favorites to pin, on Ungrouped or the empty area to remove from any folder). Drag folders into other folders, or to the top level. A collapsed folder opens when you hover over it while dragging
- **Folder Context Menu**:
  - New Connection Here — the profile editor opens with the folder already selected
  - New Subfolder
  - Open All Connections — every connection in the folder and its subfolders (asks first when there are more than 5)
  - Expand All / Collapse All — the folder and everything below it
  - Rename — subfolders follow, since Tabby links them to their parent by id
  - Edit Folder... — Tabby's group editor: parent, icon, color and per-type defaults
  - Delete Folder — when it isn't empty, choose between moving its contents to the parent folder or deleting everything in it

### Toolbar Integration
- **Toggle Button**: Click to show/hide the sidebar panel
- **Dual Access**: Use sidebar for persistent access, or toolbar for quick toggle

## Installation

### Via Tabby Plugin Manager (Recommended)

1. Open Tabby Terminal
2. Go to Settings → Plugins
3. Type `tabby-ssh-sidebar` in the search box
4. Click Install
5. Restart Tabby

### Manual Installation from NPM

```bash
cd ~/.config/tabby/plugins
npm install tabby-ssh-sidebar
```

Then restart Tabby.

### From Source

1. Clone this repository
2. Install dependencies:
   ```bash
   npm install
   ```

3. Build the plugin:
   ```bash
   npm run build
   ```

4. Install using the script:
   ```bash
   ./install.sh
   ```

5. Restart Tabby

## Usage

### Using the Sidebar Panel

1. After installation, restart Tabby - the sidebar will appear on the left side
2. **Browse Connections**: Scroll through your SSH profiles organized by groups
3. **Search**: Use the search box to filter connections by name, host, or user
4. **Connect**: Left-click any connection to open it in a new tab
5. **Active Indicators**: Green dot shows which connections are currently open
6. **Collapse Folders**: Click a folder to expand/collapse it. A green dot on a collapsed folder means a connection inside it is open
7. **Pin Favorites**: Right-click connections and select "Pin to Favorites"
8. **Edit Profiles**: Right-click and select "Edit" to open Tabby's profile editor
9. **Organize**: Create connections and folders from the header buttons or right-click menus, and drag things around to reorganize
10. **Hide Sidebar**: Click the toolbar button to toggle visibility

### Context Menu Options

Right-click any connection in the sidebar to access:
- **Connect**: Open SSH connection in new tab
- **Edit**: Open Tabby's profile editor
- **Pin to Favorites** / **Unpin from Favorites**: Manage favorite connections
- **Delete**: Remove the connection profile

### Managing Favorites

1. Right-click any connection
2. Select "Pin to Favorites"
3. The connection will appear in the "Favorites" folder at the top (you can also drag it there)
4. To unpin, right-click and select "Unpin from Favorites"

### Keyboard-Free Workflow

The sidebar enables a completely mouse-driven workflow - no need to use the command palette or keyboard shortcuts to access your SSH connections.

## Configuration

The plugin stores its configuration in Tabby's settings. Configuration is automatic:

- **Sidebar visibility**: Automatically saved when you toggle the sidebar
- **Pinned favorites**: Automatically saved when you pin/unpin connections
- **Group collapse state**: Automatically saved when you expand/collapse groups

## Requirements

- Tabby Terminal v1.0.197 or later (tested against v1.0.236)
- Node.js and npm for building

## Troubleshooting

### Empty space to the right of the terminal (fixed in 0.4.2)

Up to 0.4.1, opening the sidebar on Tabby 1.0.236 shrank the whole tab area
(tab bar, terminal, settings) to the width of its content and left the rest of
the window empty. The sidebar overrode the `width: 100vw` Tabby puts on the
main content area, but that width was the only thing sizing Tabby's `.window`
container, so `.window` collapsed to fit its content.

0.4.2 pins `.window` to the full window width while the sidebar is open.

### Duplicated profiles disappearing (fixed in 0.4.1)

Up to 0.4.0, **Duplicate** in the sidebar context menu wrote the copy without an
`id`. Tabby matches profiles by `id` nearly everywhere, so those copies didn't
appear in Tabby's own profile selector — and because deletion filtered on
`p.id !== target.id`, deleting one id-less copy removed **every** id-less
profile at once.

0.4.1 creates duplicates through Tabby's `newProfile()`, so each copy gets a
proper `${type}:custom:${slug}:${uuid}` id, and deletion now removes exactly the
profile you selected.

If a config already contains id-less profiles from an earlier version, they are
still listed and can now be deleted individually. To give them real ids, open
each one in Tabby's profile editor (Settings → Profiles) and save it.

### Installing from Settings → Plugins fails

Versions up to 0.3.2 declared `peerDependencies` pinned to Angular 17.3.5 while
Tabby's own packages ask for Angular 15. Tabby installs plugins with npm's
programmatic API and cannot pass `--legacy-peer-deps`, so npm aborted with an
`ERESOLVE` error and the install never completed.

Those peer dependencies are gone as of 0.4.0 — every one of them is a webpack
`external` that Tabby supplies at runtime, so the plugin never needed to pull
them itself. Installing from the plugin manager works again; no flags required.

## Development

### Watch mode

For development with auto-rebuild on changes:

```bash
npm run watch
```

### Build

```bash
npm run build
```

## Architecture

This plugin uses several Tabby APIs:

- **ToolbarButtonProvider**: Adds toggle button to main toolbar
- **SSHSidebarService**: Manages sidebar lifecycle and layout integration
- **ProfilesService**: Retrieves and manages SSH connection profiles
- **ConfigService**: Persists user preferences (favorites, visibility, collapse state)
- **tabby-settings modals**: `EditProfileModalComponent` and `EditProfileGroupModalComponent`, the same editors Tabby's settings tab uses

Source layout:

| File | Role |
|------|------|
| `src/index.ts` | Plugin module, toolbar button, startup |
| `src/services/sshSidebar.service.ts` | Inserts/removes the sidebar in Tabby's layout |
| `src/services/profileActions.service.ts` | Every change to profiles and groups (create, edit, move, delete) and its dialogs |
| `src/tree/profileTree.ts` | Plain functions: builds the folder tree, flattens it into rows, drag-and-drop rules |
| `src/components/sshSidebar.component.{ts,html,css}` | The sidebar UI: filter, sort, menus, drag and drop |

The sidebar is implemented as a dynamically injected Angular component. It is inserted into Tabby's `.window` element — the horizontal flex container that holds `profile-tree` and `.content.main` — so the sidebar participates in Tabby's own row layout and the terminal area simply shrinks to fit. `app-root` itself is a *column* flex container (title bar above, window below) and is deliberately left untouched.

## License

MIT
