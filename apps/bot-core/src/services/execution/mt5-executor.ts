import axios from 'axios';

import {
  ExecutionOrder,
  ExecutionResult,
} from './execution-types';

export class MT5Executor {
  private readonly baseUrl =
    'http://localhost:8000';

  async execute(
    order: ExecutionOrder,
  ): Promise<ExecutionResult> {
    try {
      const response =
        await axios.post(
          `${this.baseUrl}/api/trading/trade`,
          order,
        );

      return {
        success: true,

        orderId:
          response.data.orderId,

        message:
          'Order executed successfully',
      };
    } catch (error: any) {
      return {
        success: false,
        message:
          error?.response?.data?.message ||
          error.message ||
          'Execution failed',
      };
    }
  }
}