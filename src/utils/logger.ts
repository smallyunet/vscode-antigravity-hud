import * as vscode from 'vscode';

type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';

/**
 * Simple logger for Antigravity HUD extension
 */
class Logger {
    private outputChannel: vscode.OutputChannel;
    private debugMode: boolean = false;

    constructor() {
        this.outputChannel = vscode.window.createOutputChannel('Antigravity HUD');
    }

    setDebugMode(enabled: boolean): void {
        this.debugMode = enabled;
    }

    private log(level: LogLevel, message: string, ...args: unknown[]): void {
        const timestamp = new Date().toISOString();
        const formattedArgs = args.length > 0 ? ' ' + JSON.stringify(args) : '';
        const logMessage = `[${timestamp}] [${level}] ${message}${formattedArgs}`;

        this.outputChannel.appendLine(logMessage);

        if (level === 'ERROR') {
            console.error(logMessage);
        } else if (this.debugMode) {
            console.log(logMessage);
        }
    }

    info(message: string, ...args: unknown[]): void {
        this.log('INFO', message, ...args);
    }

    warn(message: string, ...args: unknown[]): void {
        this.log('WARN', message, ...args);
    }

    error(message: string, ...args: unknown[]): void {
        this.log('ERROR', message, ...args);
    }

    debug(message: string, ...args: unknown[]): void {
        if (this.debugMode) {
            this.log('DEBUG', message, ...args);
        }
    }

    show(): void {
        this.outputChannel.show();
    }

    dispose(): void {
        this.outputChannel.dispose();
    }
}

export const logger = new Logger();
