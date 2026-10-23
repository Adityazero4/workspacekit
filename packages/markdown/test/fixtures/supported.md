---
title: Release notes | v2
tags: [markdown, lexical]
---

# Release notes

Plain text with **bold**, *italic*, ***both***, ~~struck~~ and `inline code`.
A second line in the same paragraph, with a [link](https://example.com/a_b "Title").

## Tables

| Left | Centre | Right | Plain |
|:-----|:------:|------:|-------|
| a | **b** | `c \| d` | e \| f |
| 1 |  | 3 | [x](https://example.com) |

| Second | Table |
| --- | --- |
| kept | apart |

## Rules

***

---

* * *

## Fences

~~~python title="example.py"
def main():
    print("```")
~~~

```ts
const a = 1;
```

````md
```
nested
```
````

## Lists

- one
- two

1. first
2. second

- [ ] todo
- [x] done

> A quote
> over two lines

An image stays a link: ![alt text](https://example.com/image.png)

1\. not a list
\# not a heading
\> not a quote
\- not a bullet

Last paragraph.
