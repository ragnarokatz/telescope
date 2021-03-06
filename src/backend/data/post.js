const { getPost, addPost } = require('../utils/storage');
const { logger } = require('../utils/logger');
const sanitizeHTML = require('../utils/sanitize-html');
const textParser = require('../utils/text-parser');
const Feed = require('./feed');
const hash = require('./hash');
const ArticleError = require('./article-error');

function toDate(date) {
  if (date instanceof Date) {
    return date;
  }
  return new Date(date);
}

/**
 * Makes sure that the given feed is a Feed and not just an id.  If the latter
 * it gets the full feed.
 * @param {Feed|String} feed a Feed object or feed id
 * Returns a Promise<Feed>
 */
function ensureFeed(feed) {
  return feed instanceof Feed ? Promise.resolve(feed) : Feed.byId(feed);
}

class Post {
  constructor(title, html, datePublished, dateUpdated, postUrl, guid, feed) {
    // Use the post's guid as our unique identifier
    this.id = hash(guid);
    this.title = title;
    this.html = html;
    this.published = datePublished ? toDate(datePublished) : new Date();
    this.updated = dateUpdated ? toDate(dateUpdated) : new Date();
    this.url = postUrl;
    this.guid = guid;

    // We expect to get a real Feed vs. a feed id
    if (!(feed instanceof Feed)) {
      throw new Error(`expected feed to be a Feed Object, got '${feed}'`);
    }
    this.feed = feed;
  }

  /**
   * Save the current Post to the database, swapping the feed's id
   * for the entire Feed object.
   * Returns a Promise.
   */
  save() {
    addPost({
      ...this,
      feed: this.feed.id,
    });
  }

  /**
   * Generate the plain text version of this post on demand vs. storing
   */
  get text() {
    return textParser(this.html);
  }

  /**
   * Parse an article object into a Post object.
   * @param {Object} article parsed via feedparser, see:
   * https://www.npmjs.com/package/feedparser#what-is-the-parsed-output-produced-by-feedparser
   *
   * If data is missing, throws an error.
   */
  static async createFromArticle(article, feed) {
    // Validate the properties we get, and if we don't have them all, throw
    if (!article) {
      throw new Error('unable to parse, missing article');
    }

    // A valid RSS/Atom feed can have missing fields that we care about.
    // Keep track of any that are missing, and throw if necessary.
    const missing = [];
    // description is the content of the post
    if (!article.description) missing.push('description');
    // link is the URL of the post
    if (!article.link) missing.push('link');
    // guid is the unique identifier of the post
    if (!article.guid) missing.push('guid');

    if (missing.length) {
      const message = `invalid article: missing ${missing.join(', ')}`;
      logger.debug(message);
      throw new ArticleError(message);
    }

    // Allow for missing title, but give it one
    if (!article.title) {
      logger.debug('article missing title, substituting "Untitled"');
      article.title = 'Untitled';
    }

    // If we're missing dates, assign current date
    const today = new Date();
    if (!article.pubdate) {
      logger.debug('article missing pubdate, substituting current date');
      article.pubdate = today;
    }
    if (!article.date) {
      logger.debug('article missing date, substituting current date');
      article.date = today;
    }

    let sanitizedHTML;
    try {
      // The article.description is frequently the full HTML article content.
      // Sanitize it of any scripts or other dangerous attributes/elements
      sanitizedHTML = sanitizeHTML(article.description);
    } catch (error) {
      logger.error({ error }, 'Unable to sanitize and parse HTML for feed');
      throw error;
    }

    // NOTE: feedparser article properties are documented here:
    // https://www.npmjs.com/package/feedparser#list-of-article-properties
    const post = new Post(
      article.title,
      // sanitized HTML version of the post
      sanitizedHTML,
      // pubdate (original published date)
      article.pubdate,
      // date (most recent update)
      article.date,
      // link is the url to the post
      article.link,
      article.guid,
      feed
    );
    await post.save();
    return post.id;
  }

  /**
   * Creates a new Post object by extracting data from the given post-like object.
   * @param {Object} postData - an Object containing the necessary fields.  The
   * feed property can be an id or a full Feed Object.
   * Returns the newly created Post's id.
   */
  static async create(postData) {
    // If we only have a feed id, get the full Feed Object instead.
    const feed = await ensureFeed(postData.feed);
    const post = new Post(
      postData.title,
      postData.html,
      postData.published,
      postData.updated,
      postData.url,
      postData.guid,
      feed
    );
    await post.save();
    return post.id;
  }

  /**
   * Returns a Post from the database using the given id
   * @param {String} id - the id of a post (hashed guid) to get from Redis.
   */
  static async byId(id) {
    const data = await getPost(id);
    // No post found using this id
    if (!(data && data.id)) {
      return null;
    }

    const feed = await ensureFeed(data.feed);
    const post = new Post(
      data.title,
      data.html,
      data.published,
      data.updated,
      data.url,
      data.guid,
      feed
    );
    return post;
  }
}

module.exports = Post;
