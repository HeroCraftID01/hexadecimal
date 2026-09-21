-- Migration to add developer settings columns to profiles table

ALTER TABLE public.profiles 
ADD COLUMN IF NOT EXISTS "gatewayUrl" TEXT,
ADD COLUMN IF NOT EXISTS "seamlessRelogin" BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS "fabPosition" TEXT DEFAULT 'bottom-right';
