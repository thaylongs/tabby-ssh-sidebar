// Component templates and styles are bundled as plain strings (webpack `asset/source`)
declare module '*.html' {
    const content: string
    export default content
}

declare module '*.css' {
    const content: string
    export default content
}
