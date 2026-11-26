import React from "react";
export function Card({ title }: { title: string }) {
  return <div title={title}>{title}</div>;
}
export const List = () => (
  <ul>
    {items.map((i) => (
      <li key={i}>{i}</li>
    ))}
  </ul>
);
class Legacy extends React.Component {
  render() {
    return null;
  }
}
