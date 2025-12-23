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

    // Regex patterns for extracting connection details
    private static readonly TOKEN_REGEX = /--csrf_token[=\s]+([a-f0-9-]+)/i; // Looking for csrf_token
    // Legacy support
    private static readonly AUTH_TOKEN_REGEX = /--auth-token[=\s]+([^\s]+)/i;
    private static readonly PORT_REGEX = /--api-port[=\s]+(\d+)/i;
    private static readonly EXT_PORT_REGEX = /--extension_server_port[=\s]+(\d+)/i;

    constructor(logger: ILogger, processPatterns: string[] = ['antigravity', 'language_server', 'gemini-ls', 'gemini-code']) {
        this.processPatterns = processPatterns.map(p => p.toLowerCase());
        this.platform = os.platform();
        this.logger = logger;
        this.logger.info(`ProcessHunter initialized for platform: ${this.platform}`);
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
        let token = '';
        const csrfMatch = cmdLine.match(ProcessHunter.TOKEN_REGEX);
        if (csrfMatch) {
            token = csrfMatch[1];
        } else {
            const authMatch = cmdLine.match(ProcessHunter.AUTH_TOKEN_REGEX);
            if (authMatch) {
                token = authMatch[1];
            }
        }

        if (!token) {
            // Very common for processes to match name but not have token (e.g. helper processes), so just debug
            this.logger.debug(`No token found in candidate process ${proc.pid}`);
            return null;
        }

        // 2. Collect Candidate Ports
        const candidatePorts: number[] = [];

        // Priority 1: Extension Server Port (often the right one for IDEs)
        const extPortMatch = cmdLine.match(ProcessHunter.EXT_PORT_REGEX);
        if (extPortMatch) candidatePorts.push(parseInt(extPortMatch[1], 10));

        // Priority 2: Standard API Port
        const portMatch = cmdLine.match(ProcessHunter.PORT_REGEX);
        if (portMatch) candidatePorts.push(parseInt(portMatch[1], 10));

        // Priority 3: Scan lsof if needed (only if no explicit ports or on deep scan)
        // We always scan if we have a token but no args, or just to be safe if args failed?
        // Let's stick to adding them if arguments found nothing, or as supplements.
        if (this.platform === 'darwin' || this.platform === 'linux') {
            try {
                const lsofPorts = await this.findPortsByPid(proc.pid);
                lsofPorts.forEach(p => {
                    if (!candidatePorts.includes(p)) candidatePorts.push(p);
                });
            } catch (err) {
                this.logger.debug(`lsof failed for PID ${proc.pid}`, err);
            }
        }

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
            let cmd = '';
            // Try lsof first
            if (this.platform === 'darwin') {
                cmd = `lsof -iTCP -sTCP:LISTEN -n -P | grep -E "^\\S+\\s+${pid}\\s"`;
            } else {
                cmd = `lsof -iTCP -sTCP:LISTEN -n -P | grep -E "^\\S+\\s+${pid}\\s"`;
            }

            const { stdout } = await execAsync(cmd);
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

    /**
     * Verify connection using the specific API endpoint
     */
    private verifyConnection(port: number, token: string): Promise<boolean> {
        return new Promise(resolve => {
            const options: https.RequestOptions = {
                hostname: '127.0.0.1',
                port: port,
                path: '/exa.language_server_pb.LanguageServerService/GetUnleashData',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Codeium-Csrf-Token': token,
                    'Connect-Protocol-Version': '1'
                },
                timeout: 2000,
                rejectUnauthorized: false
            };

            const req = https.request(options, (res) => {
                this.logger.debug(`Verification request to port ${port} returned status ${res.statusCode}`);
                resolve(res.statusCode === 200);
            });

            req.on('error', (err) => {
                this.logger.debug(`Verification error on port ${port}: ${err.message}`);
                resolve(false);
            });

            req.on('timeout', () => {
                req.destroy();
                resolve(false);
            });

            req.write(JSON.stringify({ wrapper_data: {} }));
            req.end();
        });
    }

    /**
     * Update the process patterns to search for
     */
    setProcessPatterns(patterns: string[]): void {
        this.processPatterns = patterns.map(p => p.toLowerCase());
    }
}
