declare module 'dotenv' {
  export interface DotenvConfigOptions {
    path?: string
    override?: boolean
  }

  export function config(options?: DotenvConfigOptions): void
}
