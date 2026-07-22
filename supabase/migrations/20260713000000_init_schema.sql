-- ==========================================
-- SnapFlow Database Schema & Security Policy
-- ==========================================

-- 1. Profiles Table
CREATE TABLE IF NOT EXISTS public.profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    is_premium BOOLEAN DEFAULT FALSE NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
);

-- Enable RLS
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- 2. Captures Table
CREATE TABLE IF NOT EXISTS public.captures (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    provider TEXT DEFAULT 'google_drive' NOT NULL,
    external_file_id TEXT NOT NULL,
    web_view_link TEXT NOT NULL,
    title TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
);

-- Enable RLS
ALTER TABLE public.captures ENABLE ROW LEVEL SECURITY;

-- 3. Comments Table
CREATE TABLE IF NOT EXISTS public.comments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    capture_id UUID NOT NULL REFERENCES public.captures(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    position_x DOUBLE PRECISION NOT NULL, -- percentage position X (0-100)
    position_y DOUBLE PRECISION NOT NULL, -- percentage position Y (0-100)
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
);

-- Enable RLS
ALTER TABLE public.comments ENABLE ROW LEVEL SECURITY;

-- ==========================================
-- Triggers for Automation & Column Security
-- ==========================================

-- A. Auto-create Profile on Signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
BEGIN
  INSERT INTO public.profiles (id, email, is_premium)
  VALUES (new.id, new.email, FALSE);
  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- B. Prevent Client-Side Mutation of is_premium
CREATE OR REPLACE FUNCTION public.protect_profile_premium_status()
RETURNS trigger AS $$
BEGIN
  -- Strict guard: Only allow database superusers/service role (not authenticated/anon API) to modify is_premium
  IF current_user NOT IN ('service_role', 'supabase_admin', 'postgres') THEN
    NEW.is_premium := OLD.is_premium;
  END IF;
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE TRIGGER check_profile_premium_update
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.protect_profile_premium_status();

-- ==========================================
-- Row Level Security (RLS) Policies
-- ==========================================

-- Profiles Policies
CREATE POLICY "Users can read their own profile" 
    ON public.profiles FOR SELECT 
    USING (auth.uid() = id);

-- Captures Policies
CREATE POLICY "Anyone can view shared captures" 
    ON public.captures FOR SELECT 
    USING (TRUE); -- Allows public link sharing of capture pages

CREATE POLICY "Users can insert their own captures" 
    ON public.captures FOR INSERT 
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own captures" 
    ON public.captures FOR UPDATE 
    USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own captures" 
    ON public.captures FOR DELETE 
    USING (auth.uid() = user_id);

-- Comments Policies
CREATE POLICY "Anyone can view comments on shared captures" 
    ON public.comments FOR SELECT 
    USING (TRUE);

CREATE POLICY "Authenticated users can post comments" 
    ON public.comments FOR INSERT 
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own comments" 
    ON public.comments FOR UPDATE 
    USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own comments" 
    ON public.comments FOR DELETE 
    USING (auth.uid() = user_id);
