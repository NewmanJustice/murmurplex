'use strict';

function validatePost(post, agentIds, taskIds) {
  const identity = id => id === 'user' || agentIds.has(id);
  if (!post || typeof post !== 'object' || Array.isArray(post)
    || typeof post.id !== 'string' || !post.id || !identity(post.from)
    || typeof post.body !== 'string' || !post.body.trim() || post.body.length > 16000
    || typeof post.createdAt !== 'string' || !Number.isFinite(Date.parse(post.createdAt))
    || (post.taskId !== null && !taskIds.has(post.taskId))
    || !Array.isArray(post.mentions) || post.mentions.length > 50
    || post.mentions.some(id => !identity(id)) || new Set(post.mentions).size !== post.mentions.length
    || (post.requestTo !== null && !identity(post.requestTo))
    || (post.acknowledgedAt !== null && (post.requestTo === null || typeof post.acknowledgedAt !== 'string' || !Number.isFinite(Date.parse(post.acknowledgedAt))))) {
    throw new Error('Project state has an invalid notice board post.');
  }
}

module.exports = { validatePost };
