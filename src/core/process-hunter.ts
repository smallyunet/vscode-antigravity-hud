import { exec } from 'child_process';
import { promisify } from 'util';
import * as os from 'os';
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
    private static readonly PORT_REGEX = /--api-port[=\s]+(\d+)/i;
    private static readonly TOKEN_REGEX = /--auth-token[=\s]+([^\s]+)/i;
    // Alternative patterns for different argument styles
    private static readonly PORT_REGEX_ALT = /--port[=\s]+(\d+)/i;
    private static readonly TOKEN_REGEX_ALT = /--token[=\s]+([^\s]+)/i;

    constructor(processPatterns: string[] = ['antigravity', 'gemini-ls', 'gemini-code']) {
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
                    logger.info(`Found matching process: PID=${proc.pid}, Name=${proc.name}`);
                    const connection = this.extractConnection(proc);
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
        try {
            // Use WMIC to get process list with command line
            const { stdout } = await execAsync(
                'wmic process get ProcessId,Name,CommandLine /format:csv',
                { maxBuffer: 10 * 1024 * 1024 } // 10MB buffer for large process lists
            );

            const processes: ProcessInfo[] = [];
            const lines = stdout.trim().split('\n');

            // Skip header line (first non-empty line after potential empty lines)
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i].trim();
                if (!line || line.startsWith('Node,')) continue;

                // CSV format: Node,CommandLine,Name,ProcessId
                const parts = line.split(',');
                if (parts.length >= 4) {
                    const commandLine = parts.slice(1, -2).join(','); // CommandLine may contain commas
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
            // Fallback to PowerShell if WMIC fails (deprecated on newer Windows)
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

            for (let i = 1; i < lines.length; i++) { // Skip header
                const line = lines[i].trim();
                if (!line) continue;

                // Parse CSV: "ProcessId","Name","CommandLine"
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
            // Use ps with wide output to get full command line
            // -e: all processes, -o: output format, ww: wide output (no truncation)
            const { stdout } = await execAsync(
                'ps -eo pid,comm,args',
                { maxBuffer: 10 * 1024 * 1024 }
            );

            const processes: ProcessInfo[] = [];
            const lines = stdout.trim().split('\n');

            // Skip header line
            for (let i = 1; i < lines.length; i++) {
                const line = lines[i].trim();
                if (!line) continue;

                // Parse: PID COMMAND ARGS
                // PID is right-aligned, so we need to handle leading spaces
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
    private extractConnection(proc: ProcessInfo): AntigravityConnection | null {
        const cmdLine = proc.commandLine;

        // Try primary patterns first
        let portMatch = cmdLine.match(ProcessHunter.PORT_REGEX);
        let tokenMatch = cmdLine.match(ProcessHunter.TOKEN_REGEX);

        // Fallback to alternative patterns
        if (!portMatch) {
            portMatch = cmdLine.match(ProcessHunter.PORT_REGEX_ALT);
        }
        if (!tokenMatch) {
            tokenMatch = cmdLine.match(ProcessHunter.TOKEN_REGEX_ALT);
        }

        if (portMatch && tokenMatch) {
            const port = parseInt(portMatch[1], 10);
            const token = tokenMatch[1];

            if (!isNaN(port) && token) {
                return {
                    port,
                    token,
                    pid: proc.pid
                };
            }
        }

        // Log what we found for debugging
        if (portMatch) {
            logger.debug(`Found port ${portMatch[1]} but no token`);
        }
        if (tokenMatch) {
            logger.debug(`Found token but no port`);
        }

        return null;
    }

    /**
     * Update the process patterns to search for
     */
    setProcessPatterns(patterns: string[]): void {
        this.processPatterns = patterns.map(p => p.toLowerCase());
        logger.debug(`Updated process patterns: ${this.processPatterns.join(', ')}`);
    }
}
