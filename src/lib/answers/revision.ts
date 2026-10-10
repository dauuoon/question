import { z } from "zod";

// Keep PostgreSQL microseconds intact for optimistic revision checks.
export const answerRevisionSchema=z.iso.datetime({offset:true});
