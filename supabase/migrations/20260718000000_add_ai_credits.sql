-- =====================================================
-- Migration: Add AI Credits columns and update policy
-- =====================================================

-- 1. Add ai_credits and last_credit_reset to profiles table
ALTER TABLE public.profiles 
ADD COLUMN IF NOT EXISTS ai_credits INTEGER DEFAULT 5 NOT NULL,
ADD COLUMN IF NOT EXISTS last_credit_reset TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL;

-- 2. Add RLS UPDATE policy to profiles table so users can update their credits/resets.
-- Note: is_premium column mutations remain strictly protected by the database trigger
-- 'check_profile_premium_update' defined in the initial schema.
CREATE POLICY "Users can update their own profile" 
    ON public.profiles FOR UPDATE 
    USING (auth.uid() = id);
