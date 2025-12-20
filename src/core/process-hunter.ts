import { exec } from 'child_process';
import { promisify } from 'util';
import * as os from 'os';
import * as https from 'http'; // Use http for local connection, will check protocol later
import { ProcessInfo, AntigravityConnection } from '../types';
import { logger } from '../utils/logger';

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

    // Regex patterns for extracting connection details
    private static readonly TOKEN_REGEX = /--csrf_token[=\s]+([a-f0-9-]+)/i; // Looking for csrf_token
    // Legacy support
    private static readonly AUTH_TOKEN_REGEX = /--auth-token[=\s]+([^\s]+)/i;
    private static readonly PORT_REGEX = /--api-port[=\s]+(\d+)/i;
    private static readonly EXT_PORT_REGEX = /--extension_server_port[=\s]+(\d+)/i;

    constructor(processPatterns: string[] = ['antigravity', 'language_server', 'gemini-ls', 'gemini-code']) {
        this.processPatterns = processPatterns.map(p => p.toLowerCase());
        this.platform = os.platform();
        logger.info(`ProcessHunter initialized for platform: ${this.platform}`);
        logger.debug(`Searching for patterns: ${this.processPatterns.join(', ')}`);
    }

    /**
     * Hunt for Antigravity process and extract connection details
     */
    async hunt(): Promise<AntigravityConnection | null> {
        try {
            logger.debug('Starting process hunt...');
            const processes = await this.scanProcesses();
            logger.debug(`Found ${processes.length} total processes`);

            for (const proc of processes) {
                if (this.matchesPattern(proc)) {
                    logger.info(`Found candidate process: PID=${proc.pid}, Name=${proc.name}, Cmd=${proc.commandLine.substring(0, 100)}...`);

                    const connection = await this.extractConnection(proc);
                    if (connection) {
                        logger.info(`Extracted connection: port=${connection.port}`);
                        return connection;
                    }
                }
            }

            logger.debug('No matching Antigravity process found');
            return null;
        } catch (error) {
            logger.error('Process hunt failed', error);
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
                logger.warn(`Unsupported platform: ${this.platform}, attempting Unix-style scan`);
                return this.scanUnixProcesses();
        }
    }

    /**
     * Windows process scanning using WMIC
     */
    private async scanWindowsProcesses(): Promise<ProcessInfo[]> {
        // ... (Keep existing Windows logic for now, or update if needed. 
        // Focusing on Unix/Mac update as per user context which is Mac)
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
            logger.warn('WMIC failed, trying PowerShell fallback');
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
            logger.error('PowerShell process scan failed', error);
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
            logger.error('Unix process scan failed', error);
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
            logger.debug(`No token found in process ${proc.pid}`);
            return null;
        }

        // 2. Find Port
        // Strategy A: Look for port in arguments
        let port = 0;
        const portMatch = cmdLine.match(ProcessHunter.PORT_REGEX);
        if (portMatch) {
            port = parseInt(portMatch[1], 10);
        } else {
            const extPortMatch = cmdLine.match(ProcessHunter.EXT_PORT_REGEX);
            if (extPortMatch) {
                port = parseInt(extPortMatch[1], 10);
            }
        }

        // Strategy B: Use lsof/netstat if on Mac/Linux and no port in args (or if needed to verify)
        if ((!port || port === 0) && (this.platform === 'darwin' || this.platform === 'linux')) {
            logger.debug(`Port not found in args for PID ${proc.pid}, attempting lsof scan...`);
            const ports = await this.findPortsByPid(proc.pid);
            logger.debug(`Found ports via lsof for PID ${proc.pid}: ${ports.join(', ')}`);

            // Verify each port
            for (const p of ports) {
                if (await this.verifyConnection(p, token)) {
                    port = p;
                    break;
                }
            }
        } else if (port > 0) {
            // Check if explicitly found port works
            if (await this.verifyConnection(port, token)) {
                // Good
            } else {
                logger.warn(`Port ${port} found in args but failed verification.`);
                port = 0; // Invalid
            }
        }

        if (port > 0 && token) {
            return {
                port,
                token,
                csrfToken: token,
                pid: proc.pid
            };
        }

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
                // Linux fallback sequence could be implemented here
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
            logger.debug(`Failed to find ports for PID ${pid} via lsof (might need permissions or different command).`);
            return [];
        }
    }

    /**
     * Verify connection using the specific API endpoint
     */
    private verifyConnection(port: number, token: string): Promise<boolean> {
        return new Promise(resolve => {
            const options = {
                hostname: '127.0.0.1',
                port: port,
                path: '/exa.language_server_pb.LanguageServerService/GetUnleashData',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Codeium-Csrf-Token': token,
                    'Connect-Protocol-Version': '1'
                },
                timeout: 2000
            };

            const req = https.request(options, (res) => {
                logger.debug(`Verification request to port ${port} returned status ${res.statusCode}`);
                resolve(res.statusCode === 200);
            });

            req.on('error', () => resolve(false));
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
