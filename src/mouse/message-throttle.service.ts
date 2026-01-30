import { Injectable } from '@nestjs/common';
import { Operation } from './mouse.service';

/**
 * Message throttling service to batch operations and reduce message volume.
 * Prevents overwhelming the system with too many individual messages.
 */
@Injectable()
export class MessageThrottleService {
  private readonly BATCH_INTERVAL_MS = 50; // Batch messages every 50ms
  private readonly MAX_BATCH_SIZE = 20; // Max operations per batch

  private pendingBatches = new Map<
    string,
    {
      operations: Operation[];
      timeout: NodeJS.Timeout;
      resolvers: Array<(ops: Operation[]) => void>;
    }
  >();

  /**
   * Throttle operations by batching them per room.
   * Returns a promise that resolves with the batched operations when ready to send.
   * Multiple calls for the same room will be batched together.
   */
  async throttle(roomId: string, operation: Operation): Promise<Operation[]> {
    const batch = this.pendingBatches.get(roomId);

    if (batch) {
      batch.operations.push(operation);

      // If batch is full, send immediately
      if (batch.operations.length >= this.MAX_BATCH_SIZE) {
        clearTimeout(batch.timeout);
        this.pendingBatches.delete(roomId);
        const ops = [...batch.operations];
        batch.resolvers.forEach((resolve) => resolve(ops));
        return ops;
      }

      // Wait for batch to complete
      return new Promise((resolve) => {
        batch.resolvers.push(resolve);
      });
    }

    // Create new batch
    return new Promise((resolve) => {
      const operations = [operation];
      const resolvers: Array<(ops: Operation[]) => void> = [resolve];

      const timeout = setTimeout(() => {
        const batch = this.pendingBatches.get(roomId);
        if (batch && batch.operations === operations) {
          this.pendingBatches.delete(roomId);
          const ops = [...batch.operations];
          batch.resolvers.forEach((r) => r(ops));
        }
      }, this.BATCH_INTERVAL_MS);

      this.pendingBatches.set(roomId, {
        operations,
        timeout,
        resolvers,
      });
    });
  }

  /**
   * Flush all pending batches (useful for cleanup)
   */
  flush(roomId?: string): void {
    if (roomId) {
      const batch = this.pendingBatches.get(roomId);
      if (batch) {
        clearTimeout(batch.timeout);
        this.pendingBatches.delete(roomId);
        const ops = [...batch.operations];
        batch.resolvers.forEach((resolve) => resolve(ops));
      }
    } else {
      // Flush all
      for (const [id, batch] of this.pendingBatches) {
        clearTimeout(batch.timeout);
        const ops = [...batch.operations];
        batch.resolvers.forEach((resolve) => resolve(ops));
      }
      this.pendingBatches.clear();
    }
  }
}
