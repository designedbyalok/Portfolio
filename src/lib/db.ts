import { supabase } from './supabase';

export type BlogPost = {
  id: string;
  slug: string;
  title: string;
  summary: string;
  content: string;
  date: string;
  author: string;
  read_time: string | null;
  tags: string[];
  image: string | null;
  draft: boolean;
};

export type Work = {
  id: string;
  slug: string;
  title: string;
  summary: string;
  content: string;
  image: string;
  tags: string[];
  year: string;
  role: string | null;
  client: string | null;
  draft: boolean;
};

export async function getBlogPosts(): Promise<BlogPost[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('blog_posts')
    .select('*')
    .eq('draft', false)
    .order('date', { ascending: false });

  if (error) throw error;
  return data as BlogPost[];
}

export async function getBlogPost(slug: string): Promise<BlogPost | null> {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from('blog_posts')
    .select('*')
    .eq('slug', slug)
    .eq('draft', false)
    .single();

  if (error) throw error;
  return data as BlogPost;
}

export async function getWorks(): Promise<Work[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('works')
    .select('*')
    .eq('draft', false)
    .order('year', { ascending: false });

  if (error) throw error;
  return data as Work[];
}

export async function getWork(slug: string): Promise<Work | null> {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from('works')
    .select('*')
    .eq('slug', slug)
    .eq('draft', false)
    .single();

  if (error) throw error;
  return data as Work;
}
