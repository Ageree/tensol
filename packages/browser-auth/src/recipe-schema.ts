import { z } from 'zod';

export const RecipeStepSchema = z.object({
  action: z.enum(['click', 'fill', 'navigate', 'waitFor', 'submit']),
  selector: z.string().optional(),
  fillFromCred: z.enum(['username', 'password']).optional(),
  value: z.string().optional(),
  waitFor: z
    .object({
      selector: z.string(),
      timeoutMs: z.number().int().positive(),
    })
    .optional(),
});

export const LoginRecipeSchema = z.object({
  name: z.string().min(1),
  kind: z.enum(['form-post', 'oauth2-pkce', 'magic-link']),
  steps: z.array(RecipeStepSchema).min(1),
  successCheck: z.object({
    selector: z.string(),
    timeoutMs: z.number().int().positive(),
  }),
});

export type RecipeStep = z.infer<typeof RecipeStepSchema>;
export type LoginRecipe = z.infer<typeof LoginRecipeSchema>;
