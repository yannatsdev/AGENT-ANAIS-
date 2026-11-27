import React from 'react';
import { motion } from 'motion/react';

interface AnimatedWordLineProps {
  text: string;
  className?: string;
  wordClassName?: string;
  delayStart?: number;
  stagger?: number;
}

export const AnimatedWordText: React.FC<AnimatedWordLineProps> = ({
  text,
  className = '',
  wordClassName = '',
  delayStart = 0,
  stagger = 0.045,
}) => {
  const words = text.split(' ');

  return (
    <span className={className}>
      {words.map((word, idx) => (
        <motion.span
          key={`${word}-${idx}`}
          initial={{ opacity: 0, y: 12, filter: 'blur(3px)' }}
          animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
          transition={{
            duration: 0.45,
            delay: delayStart + idx * stagger,
            ease: [0.16, 1, 0.3, 1],
          }}
          className={`inline-block will-change-transform ${wordClassName}`}
        >
          {word}
          {idx < words.length - 1 ? '\u00A0' : ''}
        </motion.span>
      ))}
    </span>
  );
};
