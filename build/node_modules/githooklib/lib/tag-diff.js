function isValidVersionTag(tag) {
  return /^v\d+\.\d+\.\d+\.\d+\.\d+\.\d+$/.test(tag);
}

function getNamespacesToTrigger(newTag, prevTag) {
  const [n1, n2, n3, n4, n5, n6] = newTag.replace('v', '').split('.').map(Number);
  const [p1, p2, p3, p4, p5, p6] = prevTag?.replace('v', '').split('.').map(Number) || [0, 0, 0, 0, 0, 0];

  const namespaces = [];
  if (n1 > p1 || n2 > p2 || n3 > p3) namespaces.push('back');
  if (n4 > p4 || n5 > p5 || n6 > p6) namespaces.push('web');
  return namespaces;
}

module.exports = { isValidVersionTag, getNamespacesToTrigger };
