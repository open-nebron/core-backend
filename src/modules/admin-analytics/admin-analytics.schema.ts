import { z } from 'zod';

export const adminAnalyticsPeriodSchema = z.object({
  period: z.enum(['7d', '30d', '90d']).default('30d'),
});

export const adminAnalyticsGrowthQuerySchema = z.object({
  period: z.enum(['7d', '30d', '90d']).default('90d'),
});
