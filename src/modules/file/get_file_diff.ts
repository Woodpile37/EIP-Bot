import { context, getOctokit } from "@actions/github";
import {
  assertCategory,
  AUTHOR_RE,
  ContentFile,
  File,
  FileDiff,
  FormattedFile,
  FrontMatterAttributes,
  GITHUB_TOKEN,
  matchAll,
  ParsedContent
} from "#domain";
import frontmatter from "front-matter";
import { requireEncoding, requireFilenameEipNum, requirePr } from "#assertions";

/**
 * Accepts a file and returns the information of that file at the beginning
 * and current state of the PR; can be used to verify changes
 *
 * @param file given file name + diff to be done
 * @returns the formatted file content at the head and base of the PR
 */
export const getFileDiff = async (
  file: NonNullable<File>
): Promise<FileDiff> => {
  const pr = await requirePr();
  const filename = file.filename;

  // Get and parse head and base file
  const head = await getParsedContent(filename, pr.head.sha);
  // if the base file is new this will error, so use head instead
  const base = await getParsedContent(filename, pr.base.sha).catch(() => head);

  // Organize information cleanly
  return {
    head: await formatFile(head),
    base: await formatFile(base)
  };
};

const formatFile = async (file: ParsedContent): Promise<FormattedFile> => {
  const filenameEipNum = requireFilenameEipNum(file.name);
  if (!filenameEipNum) {
    throw `Failed to extract eip number from file "${file.path}"`;
  }

  return {
    eipNum: file.content.attributes[FrontMatterAttributes.eip],
    status: file.content.attributes[FrontMatterAttributes.status].toLowerCase(),
    authors: await getAuthors(
      file.content.attributes[FrontMatterAttributes.author]
    ),
    name: file.name,
    filenameEipNum,
    category: assertCategory({
      maybeCategory: file.content.attributes[FrontMatterAttributes.category],
      fileName: file.name,
      maybeType: file.content.attributes[FrontMatterAttributes.type]
    }).category,
    type: assertCategory({
      maybeCategory: file.content.attributes[FrontMatterAttributes.category],
      fileName: file.name,
      maybeType: file.content.attributes[FrontMatterAttributes.type]
    }).type,
  };
};

const getParsedContent = async (
  filename: string,
  sha: string
): Promise<ParsedContent> => {
  const Github = getOctokit(GITHUB_TOKEN).rest;
  const decodeData = (data: ContentFile) => {
    const encoding = data.encoding;
    requireEncoding(encoding, filename);
    return Buffer.from(data.content, encoding).toString();
  };

  // Collect the file contents at the given sha reference frame
  const data = (await Github.repos
    .getContent({
      owner: context.repo.owner,
      repo: context.repo.repo,
      path: filename,
      ref: sha
    })
    .then((res) => res.data)) as ContentFile;

  // Assert type assumptions
  if (!data?.content) {
    throw `requested file ${filename} at ref sha ${sha} contains no content`;
  }
  if (!data?.path) {
    throw `requested file ${filename} at ref sha ${sha} has no path`;
  }
  if (!data?.name) {
    throw `requested file ${filename} at ref sha ${sha} has no name`;
  }

  // Return parsed information
  return {
    path: data.path,
    name: data.name,
    content: frontmatter(decodeData(data))
  };
};

const getAuthors = async (rawAuthorList?: string) => {
  if (!rawAuthorList) return;

  const findUserByEmail = async (
    email: string
  ): Promise<string | undefined> => {
    const Github = getOctokit(GITHUB_TOKEN).rest;
    const { data: results } = await Github.search.users({ q: email });
    if (results.total_count > 0 && results.items[0] !== undefined) {
      return "@" + results.items[0].login;
    }
    console.warn(`No github user found, using email instead: ${email}`);
    return undefined;
  };

  const resolveAuthor = async (author: string) => {
    if (author[0] === "@") {
      return author.toLowerCase();
    } else {
      // Email address
      const queriedUser = await findUserByEmail(author);
      return (queriedUser || author).toLowerCase();
    }
  };

  const authors = matchAll(rawAuthorList, AUTHOR_RE, 1);
  const resolved = await Promise.all(authors.map(resolveAuthor));
  return new Set(resolved);
};
