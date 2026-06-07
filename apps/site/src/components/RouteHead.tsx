import { useEffect } from 'react';

const FAVICON_ICO = '/favicon.ico?v=sthrip-logo-1';
const FAVICON_PNG = '/assets/sthrip-logo-mark-favicon.png?v=sthrip-logo-1';

interface RouteHeadProps {
  title: string;
  description?: string;
  ogTitle?: string;
  ogDescription?: string;
  ogImage?: string;
}

export function RouteHead({ title, description, ogTitle, ogDescription, ogImage }: RouteHeadProps) {
  useEffect(() => {
    document.title = title;

    setMeta('name', 'description', description ?? '');

    setOg('og:title', ogTitle ?? title);
    setOg('og:description', ogDescription ?? description ?? '');
    setOg('og:image', ogImage ?? '');
    setFavicons();

    return () => {
      document.title = 'Sthrip';
      removeMeta('name', 'description');
      removeOg('og:title');
      removeOg('og:description');
      removeOg('og:image');
    };
  }, [title, description, ogTitle, ogDescription, ogImage]);

  return null;
}

function setFavicons() {
  document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"], link[rel="shortcut icon"]').forEach((el) => {
    el.remove();
  });

  appendIcon('icon', 'image/x-icon', FAVICON_ICO);
  appendIcon('shortcut icon', 'image/x-icon', FAVICON_ICO);
  appendIcon('icon', 'image/png', FAVICON_PNG, '64x64');
}

function appendIcon(rel: string, type: string, href: string, sizes?: string) {
  const el = document.createElement('link');
  el.rel = rel;
  el.type = type;
  el.href = href;
  if (sizes) {
    el.sizes.value = sizes;
  }
  document.head.appendChild(el);
}

function setMeta(attr: string, attrVal: string, content: string) {
  let el = document.querySelector<HTMLMetaElement>(`meta[${attr}="${attrVal}"]`);
  if (!el) {
    el = document.createElement('meta');
    el.setAttribute(attr, attrVal);
    document.head.appendChild(el);
  }
  el.content = content;
}

function setOg(property: string, content: string) {
  setMeta('property', property, content);
}

function removeMeta(attr: string, attrVal: string) {
  document.querySelector(`meta[${attr}="${attrVal}"]`)?.remove();
}

function removeOg(property: string) {
  document.querySelector(`meta[property="${property}"]`)?.remove();
}
