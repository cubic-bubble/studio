import Rimraf from 'rimraf'
import type { ProgressWatcher } from '../../types'
import Git, { CheckRepoActions, SimpleGit } from 'simple-git'
import Path from '@cubic-bubble/path'

export type GitManagerOptions = {
  cwd?: string
  auth?: { 
    username: string,
    password?: string,
    token?: string
  },
  repository?: string
  debug?: boolean
}

export default class GitManager {
  private cwd: string
  private repository: string
  private remote: string | null = null
  private git: SimpleGit

  /**
   * @params {Object} options
   *    - cwd
   *    - auth {username, token}
   *    - repository
   *    - debugMode
   */
  constructor({ cwd, auth, repository }: GitManagerOptions ){

    this.cwd = cwd || '/' // Project's current working directory
    this.repository = repository || ''

    // Define repository URL
    if( repository ) {
      this.remote = repository

      if( typeof auth == 'object'
          && auth.username
          && ( auth.password || auth.token) ) {
        const { username, password, token } = auth
        this.remote = `https://${username}:${token || password}@${repository.replace(/http(s?):\/\//, '')}`
      }
    }

    this.git = Git({
      baseDir: cwd || this.cwd, // Process.cwd()
      binary: 'git',
      maxConcurrentProcesses: 6,
      // trimmed: false
    })
  }

  // Update current working directory
  setCWD( cwd: string ){ this.git.cwd( cwd || this.cwd || process.cwd() ) }

  async initProject( remote: string | null, force?: boolean, progress?: ProgressWatcher ){
    if( !this.git )
      throw new Error('Git is not initialized')

    const
    isRepository = await this.git.checkIsRepo('root' as CheckRepoActions ),
    sync = async () => {

      // TODO: Check & pull if remote exists


      return await this.git.add('./*')
                            .commit('Initial commit!')
                            .addRemote( 'origin', remote || this.remote as string )

                            /*
                             * Fetch only when remote already exists
                             * .fetch()
                             */
                            .push([ '--set-upstream', 'origin', 'master'])
    }

    if( isRepository ) {
      if( !force )
        throw new Error('Directory is a git repository')

      // Force init on .git initialize repo: Just replace current remote origin
      await this.git.removeRemote('origin')
      await sync()

      return
    }

    await this.git.init()
    await sync()
  }

  async cloneProject( repository: string, path: string, clear?: boolean ){
    // Clone Git repository to local
    await this.git.clone( repository || this.repository, path )
    // Completely uninitialize (remove) .git after project cloned
    clear && this.clear( path )
  }

  clear( path: string ){
    // Remove git completely from a directory
    return new Promise( resolve => Rimraf( Path.resolve( this.cwd, `${path || ''}/.git` ), resolve ) )
  }
}