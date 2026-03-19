import { defineCollection, z } from 'astro:content';

const blog = defineCollection({
  schema: z.object({
    title: z.string(),
    summary: z.string(),
    date: z.date(),
    image: z.string().optional(),
    author: z.string().default('Alok Kumar'),
    readTime: z.string().optional(),
    tags: z.array(z.string()).default([]),
    draft: z.boolean().default(false),
  }),
});

const works = defineCollection({
  schema: z.object({
    title: z.string(),
    summary: z.string(),
    image: z.string(),
    tags: z.array(z.string()).default([]),
    year: z.string(),
    role: z.string().optional(),
    client: z.string().optional(),
    draft: z.boolean().default(false),
  }),
});

export const collections = { blog, works };
