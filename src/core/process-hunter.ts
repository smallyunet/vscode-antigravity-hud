import { exec } from 'child_process';
import { promisify } from 'util';
import * as os from 'os';
import * as https from 'https';
import { AntigravityConnection, ProcessInfo } from '../types';
import { ILogger } from './interfaces';

const execAsync = promisify(exec);

/**
 * ProcessHunter - Cross-platform process scanner for Antigravity processes
 * 
 * Scans system processes to locate Antigravity editor or Language Server,
 * then extracts --api-port and --auth-token from command line arguments.
 */
export class ProcessHunter {
    private processPatterns: string[];
    private platform: NodeJS.Platform;
    private logger: ILogger;

    private verificationPaths: string[];
    private verificationTimeoutMs: number;

    private static readonly MAX_DIAGNOSTIC_CANDIDATES = 30;

    // Regex patterns for extracting connection details
    private static readonly TOKEN_REGEX = /--csrf[_-]?token(?:=|\s)+([^\s"']+)/i;
    private static readonly AUTH_TOKEN_REGEX = /--auth[_-]?token(?:=|\s)+([^\s"']+)/i;
    private static readonly PORT_REGEX = /--api[_-]?port(?:=|\s)+(\d+)/i;
    private static readonly EXT_PORT_REGEX = /--extension[_-]?server[_-]?port(?:=|\s)+(\d+)/i;

    private static readonly DEFAULT_VERIFICATION_PATHS = [
        '/exa.language_server_pb.LanguageServerService/GetUserStatus',
        '/exa.language_server_pb.LanguageServerService/GetUnleashData'
    ];

    constructor(
        logger: ILogger,
        processPatterns: string[] = ['antigravity', 'language_server', 'gemini-ls', 'gemini-code'],
        verificationPaths: string[] = ProcessHunter.DEFAULT_VERIFICATION_PATHS,
        verificationTimeoutMs: number = 3500
    ) {
        this.processPatterns = processPatterns.map(p => p.toLowerCase());
        this.platform = os.platform();
        this.logger = logger;
        this.verificationPaths = this.normalizeVerificationPaths(verificationPaths);
        this.verificationTimeoutMs = verificationTimeoutMs;
        this.logger.info(`ProcessHunter initialized for platform: ${this.platform}`);
    }

    private normalizeVerificationPaths(paths: string[]): string[] {
        const result: string[] = [];

        for (const rawPath of paths) {
            if (!rawPath) {
                continue;
            }

            const trimmed = rawPath.trim();
            if (!trimmed) {
                continue;
            }

            const normalized = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
            if (!result.includes(normalized)) {
                result.push(normalized);
            }
        }

        if (result.length > 0) {
            return result;
        } else {
            return [...ProcessHunter.DEFAULT_VERIFICATION_PATHS];
        }
    }

    /**
     * Hunt for Antigravity process and extract connection details
     */
    async hunt(): Promise<AntigravityConnection | null> {
        try {
            this.logger.info('Starting process hunt...');
            const processes = await this.scanProcesses();
            this.logger.info(`Found ${processes.length} total processes`);

            for (const proc of processes) {
                if (this.matchesPattern(proc)) {
                    // Only debug log candidate finding to reduce noise
                    this.logger.debug(`Found candidate process: PID=${proc.pid}, Name=${proc.name}`);

                    const connection = await this.extractConnection(proc);
                    if (connection) {
                        this.logger.info(`✅ Successfully connected to Antigravity process on port ${connection.port}`);
                        return connection;
                    }
                    // Silent failure for individual candidates if they don't have tokens/ports
                }
            }

            this.logger.info('No valid Antigravity connection found after checking all candidates.');
            return null;
        } catch (error) {
            this.logger.error('Process hunt failed', error);
            return null;
        }
    }

    /**
     * Diagnostics helper: runs a verbose process scan and logs why connection detection may fail.
     * This never shows any UI popups; it only writes to the extension output channel.
     */
    public async diagnose(): Promise<void> {
        const start = Date.now();

        this.logger.info('Diagnostics: starting process scan...');
        this.logger.info(`Diagnostics: platform=${this.platform}`);
        this.logger.info(`Diagnostics: processPatterns=${JSON.stringify(this.processPatterns)}`);
        this.logger.info(`Diagnostics: verificationPaths=${JSON.stringify(this.verificationPaths)}`);
        this.logger.info(`Diagnostics: verificationTimeoutMs=${this.verificationTimeoutMs}`);

        let processes: ProcessInfo[] = [];
        try {
            processes = await this.scanProcesses();
        } catch (error) {
            this.logger.error('Diagnostics: scanProcesses threw an error', error);
            return;
        }

        this.logger.info(`Diagnostics: totalProcesses=${processes.length}`);

        const candidates = processes.filter(p => this.matchesPattern(p));
        this.logger.info(`Diagnostics: candidates=${candidates.length}`);

        if (candidates.length === 0) {
            this.logger.warn('Diagnostics: no candidate processes matched patterns. Try adjusting antigravity-hud.processPatterns.');
        }

        const limitedCandidates = candidates.slice(0, ProcessHunter.MAX_DIAGNOSTIC_CANDIDATES);
        if (candidates.length > limitedCandidates.length) {
            this.logger.warn(`Diagnostics: showing first ${limitedCandidates.length} candidates (truncated from ${candidates.length})`);
        }

        for (const proc of limitedCandidates) {
            await this.diagnoseCandidate(proc);
        }

        const elapsedMs = Date.now() - start;
        this.logger.info(`Diagnostics: finished in ${elapsedMs}ms`);
    }

    private async diagnoseCandidate(proc: ProcessInfo): Promise<void> {
        this.logger.info(`Diagnostics: candidate PID=${proc.pid}, name=${proc.name}`);

        const cmdLine = proc.commandLine;
        const token = this.extractToken(cmdLine);

        if (!token) {
            this.logger.warn('Diagnostics: token not found in command line (this candidate will be ignored during normal detection)');
            return;
        } else {
            this.logger.info(`Diagnostics: token=${this.maskSecret(token)}`);
        }

        const candidatePorts = await this.collectCandidatePorts(proc.pid, cmdLine, true);
        if (candidatePorts.length === 0) {
            this.logger.warn('Diagnostics: no candidate ports found (neither args nor lsof)');
            return;
        } else {
            this.logger.info(`Diagnostics: ports=${candidatePorts.join(', ')}`);
        }

        for (const port of candidatePorts) {
            const results = await this.verifyConnectionDetailed(port, token);
            const ok = results.some(r => r.ok);

            if (ok) {
                const okPaths = results.filter(r => r.ok).map(r => r.path).join(', ');
                this.logger.info(`Diagnostics: port ${port} verified OK on ${okPaths}`);
                return;
            } else {
                for (const r of results) {
                    const status = r.statusCode ? `status=${r.statusCode}` : 'status=none';
                    const err = r.error ? `error=${r.error}` : 'error=none';
                    this.logger.info(`Diagnostics: port ${port} path=${r.path} ok=false ${status} ${err}`);
                }
            }
        }

        this.logger.warn('Diagnostics: candidate had token/ports but none verified; likely apiPath mismatch or local endpoint not reachable');
    }

    /**
     * Scan system processes based on platform
     */
    private async scanProcesses(): Promise<ProcessInfo[]> {
        switch (this.platform) {
            case 'win32':
                return this.scanWindowsProcesses();
            case 'darwin':
            case 'linux':
                return this.scanUnixProcesses();
            default:
                this.logger.warn(`Unsupported platform: ${this.platform}, attempting Unix-style scan`);
                return this.scanUnixProcesses();
        }
    }

    /**
     * Windows process scanning using WMIC
     */
    private async scanWindowsProcesses(): Promise<ProcessInfo[]> {
        try {
            const { stdout } = await execAsync(
                'wmic process get ProcessId,Name,CommandLine /format:csv',
                { maxBuffer: 10 * 1024 * 1024 }
            );

            const processes: ProcessInfo[] = [];
            const lines = stdout.trim().split('\n');

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i].trim();
                if (!line || line.startsWith('Node,')) continue;

                const parts = line.split(',');
                if (parts.length >= 4) {
                    const commandLine = parts.slice(1, -2).join(',');
                    const name = parts[parts.length - 2];
                    const pidStr = parts[parts.length - 1];
                    const pid = parseInt(pidStr, 10);

                    if (!isNaN(pid) && name) {
                        processes.push({ pid, name, commandLine });
                    }
                }
            }
            return processes;
        } catch (error) {
            this.logger.warn('WMIC failed, trying PowerShell fallback');
            return this.scanWindowsProcessesPowerShell();
        }
    }

    /**
     * PowerShell fallback for Windows process scanning
     */
    private async scanWindowsProcessesPowerShell(): Promise<ProcessInfo[]> {
        try {
            const { stdout } = await execAsync(
                'powershell -Command "Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine | ConvertTo-Csv -NoTypeInformation"',
                { maxBuffer: 10 * 1024 * 1024 }
            );

            const processes: ProcessInfo[] = [];
            const lines = stdout.trim().split('\n');

            for (let i = 1; i < lines.length; i++) {
                const line = lines[i].trim();
                if (!line) continue;

                const match = line.match(/"(\d+)","([^"]+)","(.*)"/);
                if (match) {
                    const pid = parseInt(match[1], 10);
                    const name = match[2];
                    const commandLine = match[3];
                    processes.push({ pid, name, commandLine });
                }
            }

            return processes;
        } catch (error) {
            this.logger.error('PowerShell process scan failed', error);
            return [];
        }
    }

    /**
     * Unix (macOS/Linux) process scanning using ps
     */
    private async scanUnixProcesses(): Promise<ProcessInfo[]> {
        try {
            // Using ps -ww -eo pid,comm,args
            const { stdout } = await execAsync(
                'ps -ww -eo pid,comm,args',
                { maxBuffer: 10 * 1024 * 1024 }
            );

            const processes: ProcessInfo[] = [];
            const lines = stdout.trim().split('\n');

            for (let i = 1; i < lines.length; i++) {
                const line = lines[i].trim();
                if (!line) continue;

                const match = line.match(/^\s*(\d+)\s+(\S+)\s+(.*)/);
                if (match) {
                    const pid = parseInt(match[1], 10);
                    const name = match[2];
                    const commandLine = match[3];
                    processes.push({ pid, name, commandLine });
                }
            }

            return processes;
        } catch (error) {
            this.logger.error('Unix process scan failed', error);
            return [];
        }
    }

    /**
     * Check if a process matches our target patterns
     */
    private matchesPattern(proc: ProcessInfo): boolean {
        const nameLower = proc.name.toLowerCase();
        const cmdLower = proc.commandLine.toLowerCase();

        return this.processPatterns.some(pattern =>
            nameLower.includes(pattern) || cmdLower.includes(pattern)
        );
    }

    /**
     * Extract connection details from process command line
     */
    private async extractConnection(proc: ProcessInfo): Promise<AntigravityConnection | null> {
        const cmdLine = proc.commandLine;

        // 1. Find Token (Priority: csrf_token -> auth-token)
        const token = this.extractToken(cmdLine);

        if (!token) {
            // Very common for processes to match name but not have token (e.g. helper processes), so just debug
            this.logger.debug(`No token found in candidate process ${proc.pid}`);
            return null;
        }

        // 2. Collect Candidate Ports
        const candidatePorts = await this.collectCandidatePorts(proc.pid, cmdLine, false);

        if (candidatePorts.length === 0) {
            this.logger.debug(`No ports found (args or lsof) for PID ${proc.pid}`);
            return null;
        }

        this.logger.debug(`Verifying candidate ports for PID ${proc.pid}: ${candidatePorts.join(', ')}`);

        // Verify ports
        for (const port of candidatePorts) {
            if (port <= 0) continue;

            const isValid = await this.verifyConnection(port, token);
            if (isValid) {
                return {
                    port,
                    token,
                    csrfToken: token,
                    pid: proc.pid
                };
            }
        }

        // Only warn if we had a token (strong candidate) but failed all ports
        this.logger.warn(`Failed to verify connection for PID ${proc.pid} (Token found, ports checked: ${candidatePorts.join(', ')})`);
        return null;
    }

    /**
     * Find listening ports for a PID on Unix-like systems
     */
    private async findPortsByPid(pid: number): Promise<number[]> {
        try {
            const cmd = `lsof -n -P -a -p ${pid} -iTCP -sTCP:LISTEN`;
            const { stdout } = await execAsync(cmd, { maxBuffer: 10 * 1024 * 1024 });
            const ports: number[] = [];
            const lines = stdout.split('\n');

            for (const line of lines) {
                if (!line.includes('(LISTEN)')) continue;
                // Parse *:PORT or 127.0.0.1:PORT
                const match = line.match(/[*\d.:]+:(\d+)\s+\(LISTEN\)/);
                if (match) {
                    const p = parseInt(match[1], 10);
                    if (!isNaN(p) && !ports.includes(p)) {
                        ports.push(p);
                    }
                }
            }
            return ports;
        } catch (error) {
            // grep returns 1 if no matches, which rejects execAsync. This is normal.
            return [];
        }
    }

    private async findPortsByPidVerbose(pid: number): Promise<number[]> {
        try {
            return await this.findPortsByPid(pid);
        } catch (error) {
            this.logger.warn(`Diagnostics: lsof lookup failed for PID ${pid}`, error);
            return [];
        }
    }

    /**
     * Verify connection using the specific API endpoint
     */
    private async verifyConnection(port: number, token: string): Promise<boolean> {
        for (const path of this.verificationPaths) {
            const ok = await this.verifyConnectionOnPath(port, token, path);
            if (ok) {
                return true;
            }
        }
        return false;
    }

    private async verifyConnectionDetailed(port: number, token: string): Promise<Array<{ path: string; ok: boolean; statusCode?: number; error?: string }>> {
        const results: Array<{ path: string; ok: boolean; statusCode?: number; error?: string }> = [];

        for (const path of this.verificationPaths) {
            const result = await this.verifyConnectionOnPathDetailed(port, token, path);
            results.push(result);
        }

        return results;
    }

    private verifyConnectionOnPath(port: number, token: string, path: string): Promise<boolean> {
        return this.verifyConnectionOnPathDetailed(port, token, path).then(r => r.ok);
    }

    private verifyConnectionOnPathDetailed(
        port: number,
        token: string,
        path: string
    ): Promise<{ path: string; ok: boolean; statusCode?: number; error?: string }> {
        return new Promise(resolve => {
            const options: https.RequestOptions = {
                hostname: '127.0.0.1',
                port,
                path,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Codeium-Csrf-Token': token,
                    'Connect-Protocol-Version': '1'
                },
                timeout: this.verificationTimeoutMs,
                rejectUnauthorized: false
            };

            const req = https.request(options, (res) => {
                this.logger.debug(`Verification request to ${path} on port ${port} returned status ${res.statusCode}`);
                res.resume();
                resolve({ path, ok: res.statusCode === 200, statusCode: res.statusCode });
            });

            req.on('error', (err) => {
                this.logger.debug(`Verification error on ${path} port ${port}: ${err.message}`);
                resolve({ path, ok: false, error: err.message });
            });

            req.on('timeout', () => {
                req.destroy();
                resolve({ path, ok: false, error: 'timeout' });
            });

            req.write(JSON.stringify({
                wrapper_data: {},
                metadata: {
                    ide_name: 'antigravity',
                    extension_name: 'antigravity',
                    locale: 'en'
                }
            }));
            req.end();
        });
    }

    private extractToken(commandLine: string): string {
        const csrfMatch = commandLine.match(ProcessHunter.TOKEN_REGEX);
        if (csrfMatch) {
            return csrfMatch[1];
        } else {
            const authMatch = commandLine.match(ProcessHunter.AUTH_TOKEN_REGEX);
            if (authMatch) {
                return authMatch[1];
            } else {
                return '';
            }
        }
    }

    private maskSecret(secret: string): string {
        if (secret.length <= 8) {
            return '***';
        }

        const prefix = secret.slice(0, 4);
        const suffix = secret.slice(-4);
        return `${prefix}...${suffix}`;
    }

    private async collectCandidatePorts(pid: number, commandLine: string, verbose: boolean): Promise<number[]> {
        const candidatePorts: number[] = [];

        const extPortMatch = commandLine.match(ProcessHunter.EXT_PORT_REGEX);
        if (extPortMatch) {
            const extPort = parseInt(extPortMatch[1], 10);
            if (!isNaN(extPort)) {
                candidatePorts.push(extPort);
            }
        }

        const portMatch = commandLine.match(ProcessHunter.PORT_REGEX);
        if (portMatch) {
            const apiPort = parseInt(portMatch[1], 10);
            if (!isNaN(apiPort) && !candidatePorts.includes(apiPort)) {
                candidatePorts.push(apiPort);
            }
        }

        if (this.platform === 'darwin' || this.platform === 'linux') {
            const lsofPorts = verbose
                ? await this.findPortsByPidVerbose(pid)
                : await this.findPortsByPid(pid);

            for (const p of lsofPorts) {
                if (!candidatePorts.includes(p)) {
                    candidatePorts.push(p);
                }
            }
        }

        return candidatePorts.filter(p => p > 0);
    }

    /**
     * Update the API paths used during connection verification
     */
    setVerificationPaths(paths: string[]): void {
        this.verificationPaths = this.normalizeVerificationPaths(paths);
        this.logger.debug(`Verification paths updated: ${this.verificationPaths.join(', ')}`);
    }

    /**
     * Update the process patterns to search for
     */
    setProcessPatterns(patterns: string[]): void {
        this.processPatterns = patterns.map(p => p.toLowerCase());
    }
}
