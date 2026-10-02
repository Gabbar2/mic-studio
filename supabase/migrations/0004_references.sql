-- Reference-to-video support. Safe to run more than once.

alter table public.generations
  add column if not exists reference_video_url text,
  add column if not exists reference_image_urls text[] not null default '{}';

comment on column public.generations.reference_video_url is
  'Optional video whose motion/style the generation follows (Kling O3 element).';
comment on column public.generations.reference_image_urls is
  'Up to 4 style/appearance references, addressed in the prompt as @Image1..@Image4.';

-- Widen the mode check to admit the new generation mode.
alter table public.generations drop constraint if exists generations_mode_check;
alter table public.generations
  add constraint generations_mode_check
  check (mode in ('text2video', 'image2video', 'reference2video'));
