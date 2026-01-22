import * as vscode from 'vscode';
import { ModelQuota } from '../types';

/**
 * Format percentage for display (as raw number)
 */
export function formatPercentage(model: ModelQuota): number {
    return model.limit > 0 ? Math.round((model.remaining / model.limit) * 100) : 0;
}

/**
 * Format percentage for display (as string, handling buckets)
 */
export function formatPercentageDisplay(model: ModelQuota): string {
    const percentage = formatPercentage(model);

    if (model.isLikelyBucketed && percentage > 0 && percentage % 20 === 0) {
        // e.g., 100% -> 80-100%, 80% -> 60-80%
        return `${percentage - 20}-${percentage}%`;
    }

    return `${percentage}%`;
}

/**
 * Format full quota text (e.g., "50/100 (50%)" or "80-100%")
 */
export function formatQuotaText(model: ModelQuota): string {
    const percentDisplay = formatPercentageDisplay(model);

    if (model.isFractional || model.isLikelyBucketed) {
        return percentDisplay;
    }

    return `${model.remaining}/${model.limit} (${percentDisplay})`;
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
 * Format absolute time (HH:MM)
 */
export function formatAbsoluteTime(date: Date): string {
    const h = date.getHours().toString().padStart(2, '0');
    const m = date.getMinutes().toString().padStart(2, '0');
    return `${h}:${m}`;
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
 * Get battery-style bar display based on quota percentage
 * Maps quota buckets (0, 20, 40, 60, 80, 100) to 5-bar battery display
 * Examples: 100% -> ▮▮▮▮▮, 80% -> ▮▮▮▮▯, 60% -> ▮▮▮▯▯, etc.
 */
export function getBatteryBar(percentage: number): string {
    const normalized = Math.max(0, Math.min(100, percentage));

    // Determine number of filled bars (0-5)
    const filledBars = Math.max(0, Math.min(5, Math.round(normalized / 20)));
    const emptyBars = 5 - filledBars;
    
    // Use block characters for battery display
    const filled = '▮'.repeat(filledBars);
    const empty = '▯'.repeat(emptyBars);
    
    return filled + empty;
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
