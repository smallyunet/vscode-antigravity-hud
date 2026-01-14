import * as vscode from 'vscode';
import { ModelQuota } from '../types';

/**
 * Format percentage for display
 */
export function formatPercentage(model: ModelQuota): number {
    return model.limit > 0 ? Math.round((model.remaining / model.limit) * 100) : 0;
}

/**
 * Format reset time relative to now
 */
export function formatResetTime(date: Date): string {
    const now = new Date();
    const diff = date.getTime() - now.getTime();

    if (diff <= 0) {
        return 'now';
    }

    const hours = Math.floor(diff / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));

    if (hours > 0) {
        return `${hours}h ${minutes}m`;
    }
    return `${minutes}m`;
}

/**
 * Format time for display
 */
export function formatTime(date: Date): string {
    return date.toLocaleTimeString();
}

/**
 * Format duration in seconds to readable string
 */
export function formatDuration(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
}

/**
 * Format visually percentage as a bar
 * e.g. [■■■□□]
 */
export function formatProgressBar(percentage: number, width: number = 5): string {
    const filled = Math.round((percentage / 100) * width);
    const empty = width - filled;
    return '█'.repeat(filled) + '░'.repeat(empty);
}

/**
 * Get icon based on percentage
 */
export function getIconForPercentage(percentage: number): string {
    if (percentage <= 20) {
        return '$(warning)'; // Red
    } else if (percentage <= 50) {
        return '$(issue-opened)'; // Yellow
    }
    return '$(pass)'; // Green
}

/**
 * Get background color based on percentage
 */
export function getBackgroundColorForPercentage(percentage: number): vscode.ThemeColor | undefined {
    if (percentage <= 20) {
        return new vscode.ThemeColor('statusBarItem.errorBackground');
    } else if (percentage <= 50) {
        return new vscode.ThemeColor('statusBarItem.warningBackground');
    }
    return undefined;
}

/**
 * Get color based on percentage
 */
export function getColorForPercentage(percentage: number): string | vscode.ThemeColor | undefined {
    return undefined; // Keep text color default/white when using background colors for better contrast
}

/**
 * Get icon for QuickPick based on model quota
 */
export function getQuickPickIcon(model: ModelQuota): string {
    const percent = formatPercentage(model);

    if (percent <= 20) return 'error';
    if (percent <= 50) return 'warning';
    return 'pass';
}
