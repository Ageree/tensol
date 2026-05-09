import { useEffect } from 'react';

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

    return () => {
      document.title = 'Tensol';
      removeMeta('name', 'description');
      removeOg('og:title');
      removeOg('og:description');
      removeOg('og:image');
    };
  }, [title, description, ogTitle, ogDescription, ogImage]);

  return null;
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
