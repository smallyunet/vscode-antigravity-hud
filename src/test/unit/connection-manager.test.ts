import { expect } from 'chai';
import { EventEmitter } from 'events';
import { ConnectionManager } from '../../core/connection-manager';
import { ProcessHunter } from '../../core/process-hunter';
import { QuotaPoller } from '../../core/quota-poller';
import { AntigravityConnection, QuotaUpdateEvent } from '../../types';

import { ILogger } from '../../core/interfaces';

// Manual Mocks
class MockLogger implements ILogger {
    debug(message: string, ...args: any[]): void { }
    info(message: string, ...args: any[]): void { }
    warn(message: string, ...args: any[]): void { }
    error(message: string, ...args: any[]): void { }
}

class MockProcessHunter extends ProcessHunter {
    constructor(logger: ILogger) { super(logger, []); }
    huntResult: AntigravityConnection | null = null;
    huntCalled = 0;

    async hunt(): Promise<AntigravityConnection | null> {
        this.huntCalled++;
        return this.huntResult;
    }
}

class MockQuotaPoller extends QuotaPoller {
    constructor(logger: ILogger) { super(logger, 60, ''); }
    startCalled = 0;
    stopCalled = 0;
    connectionSet: AntigravityConnection | null = null;

    start(): void { this.startCalled++; }
    stop(): void { this.stopCalled++; }
    setConnection(conn: AntigravityConnection | null): void { this.connectionSet = conn; }

    // Helper to simulate events
    triggerUpdate(event: QuotaUpdateEvent) {
        this.emit('update', event);
    }
}

describe('ConnectionManager', () => {
    let connectionManager: ConnectionManager;
    let mockHunter: MockProcessHunter;
    let mockPoller: MockQuotaPoller;
    let mockLogger: MockLogger;
    let clock: NodeJS.Timeout[];

    beforeEach(() => {
        mockLogger = new MockLogger();
        mockHunter = new MockProcessHunter(mockLogger);
        mockPoller = new MockQuotaPoller(mockLogger);
        connectionManager = new ConnectionManager(mockHunter, mockPoller, mockLogger);
        // We can't easily mock setTimeout without sinon, so we'll test logical flow 
        // or ensure backoff is short for tests if we doing async waits, 
        // but ConnectionManager logic is time-based.
        // For unit tests without sinon/fake-timers, we might need to rely on 
        // inspecting state or using very short timeouts if we were testing async behavior extensively.
        // However, we can inspect 'statue' changes which happen synchronously usually before the timeout.
    });

    afterEach(() => {
        connectionManager.disconnect();
    });

    it('should connect successfully if process is found', async () => {
        const fakeConn = { port: 1234, token: 'abc', csrfToken: 'abc', pid: 999 };
        mockHunter.huntResult = fakeConn;

        await connectionManager.connect();

        expect(mockHunter.huntCalled).to.equal(1);
        expect(mockPoller.connectionSet).to.deep.equal(fakeConn);
        expect(mockPoller.startCalled).to.equal(1);
        expect(connectionManager.getStatus()).to.equal('connected');
    });

    it('should retry if process is not found', async () => {
        mockHunter.huntResult = null; // Fail first hunt

        await connectionManager.connect();

        expect(mockHunter.huntCalled).to.equal(1);
        expect(connectionManager.getStatus()).to.equal('disconnected');
        // We expect it to be disconnected (waiting for retry)
        // We can't easily test the auto-retry execution without fake timers here
        // unless we modify ConnectionManager to expose the timer or use a wrapper.
    });

    it('should trigger retry on poll error', async () => {
        const fakeConn = { port: 1234, token: 'abc', csrfToken: 'abc', pid: 999 };
        mockHunter.huntResult = fakeConn;
        await connectionManager.connect();

        // Simulate error
        mockPoller.triggerUpdate({ quota: null, error: new Error('ECONNREFUSED') });

        expect(mockPoller.stopCalled).to.equal(1);
        expect(connectionManager.getStatus()).to.equal('disconnected'); // Should transition to disconnected/retry
    });

    it('should reset retry count on successful poll', async () => {
        // This is harder to test without inspecting private state, 
        // but we can imply it by ensuring it stays connected.
        const fakeConn = { port: 1234, token: 'abc', csrfToken: 'abc', pid: 999 };
        mockHunter.huntResult = fakeConn;
        await connectionManager.connect();

        mockPoller.triggerUpdate({ quota: { models: [], lastUpdated: new Date() }, error: undefined });

        expect(connectionManager.getStatus()).to.equal('connected');
    });

    it('refresh should restart connection', async () => {
        const fakeConn = { port: 1234, token: 'abc', csrfToken: 'abc', pid: 999 };
        mockHunter.huntResult = fakeConn;
        await connectionManager.connect();

        expect(mockHunter.huntCalled).to.equal(1);

        await connectionManager.refresh();

        expect(mockPoller.stopCalled).to.equal(1); // from disconnect() inside refresh
        expect(mockHunter.huntCalled).to.equal(2);
    });
});
