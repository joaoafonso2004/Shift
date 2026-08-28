-- Shift 0007 — searchable profiles, with faces.
--
-- 0006 gated avatars on friendship alone, which made search results faceless.
-- You cannot tell which of three people called Ana is the one you train with,
-- and a friend request sent to the wrong person cannot be taken back by the
-- sender. So a discoverable profile's photo is part of what makes it findable.
--
-- `discoverable` becomes the single control: off removes you from search
-- entirely, photo included. A block still overrides everything.

drop policy avatars_read on storage.objects;

create policy avatars_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'avatars'
    and (
      (storage.foldername(name))[1] = auth.uid()::text
      or (
        not is_blocked_with(((storage.foldername(name))[1])::uuid)
        and (
          are_friends(((storage.foldername(name))[1])::uuid)
          or exists (
            select 1 from profiles p
             where p.id = ((storage.foldername(name))[1])::uuid
               and (p.privacy->>'discoverable')::boolean is true
          )
        )
      )
    )
  );

-- Search by handle or by display name.
--
-- People look for the name they know someone by, which is rarely the handle
-- they picked. Trigram indexes make both work with a partial, misspelled or
-- differently-cased query — an exact-match lookup only helps someone who
-- already knows the handle, and that person did not need to search.
create extension if not exists pg_trgm;

create index profiles_handle_trgm_idx on profiles using gin (handle gin_trgm_ops);
create index profiles_display_name_trgm_idx on profiles using gin (display_name gin_trgm_ops);

/**
 * Ranked profile search.
 *
 * Security definer so it can rank across discoverable profiles without every
 * caller needing select access to the whole table. It returns only what a
 * search result needs — no stats, no privacy object.
 */
create function search_profiles(p_query text, p_limit int default 20)
returns table (
  id uuid,
  handle text,
  display_name text,
  avatar_path text,
  score real
)
language sql security definer stable set search_path = public as $$
  select p.id,
         p.handle,
         p.display_name,
         p.avatar_path,
         greatest(
           similarity(coalesce(p.handle, ''), lower(p_query)),
           similarity(coalesce(p.display_name, ''), p_query)
         ) as score
    from profiles p
   where p.id <> auth.uid()
     and (p.privacy->>'discoverable')::boolean is true
     and not is_blocked_with(p.id)
     and (
       -- An exact handle always wins, whatever the fuzzy score says.
       lower(coalesce(p.handle, '')) = lower(p_query)
       or coalesce(p.handle, '') ilike '%' || p_query || '%'
       or coalesce(p.display_name, '') ilike '%' || p_query || '%'
     )
   order by (lower(coalesce(p.handle, '')) = lower(p_query)) desc, score desc
   limit least(p_limit, 50);
$$;
